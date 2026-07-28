# Dolly Model Provider Broker

Status: Draft

This document defines the proposed shared contract for model operations through
a host-owned broker. It is normative only after acceptance under
`docs/spec/README.md`.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119 and RFC 8174 when
they appear in all capitals.

## 1. Scope and ownership

The **model provider broker** is the trusted host component that accepts a
normalized model operation, resolves its immutable model description and
deployment endpoint, invokes the declared provider adapter, and returns a
normalized result. It alone owns provider network connections, credentials,
temporary Media disclosure, budgets, and retry decisions. The word broker is
used in its conventional intermediary sense: it lets Modules request a model
operation without giving them the underlying authority. It is not an
installable conversation extension, a Module, a Memory implementation, or a
universal provider application programming interface (API).

This specification owns:

- model descriptor identity, registry, validation, and immutable snapshots;
- endpoint/model/operation feature descriptions;
- the shared invocation envelope, budgets, cancellation, usage, errors, and
  retry classification;
- the normalized input/output (I/O) for `chat-completion`, `embedding`, and
  `rerank`;
- the handoff from model media requirements to media-owned grants; and
- adapter conformance to the exact provider protocol and controlled live test
  requirements.

Other specifications retain their existing ownership:

- `extension-process-protocol.md` owns capability transport, process isolation,
  handle scope, revocation, and protocol errors;
- `core-runtime.md` owns Module jobs, Runs, generation fencing,
  `moduleJobId`, `runId`, cancellation, and AccessLeases;
- `media.md` owns registered Media, crop requests, storage, signing, provider
  upload, deletion, and `provider-access` lease semantics;
- `block-payload.md` owns canonical content and media references;
- `llm-extension.md` owns conversation state, role trust, reasoning policy,
  tools, and turn commit;
- `memory-extension.md` owns feature provenance, index generations,
  retrieval, fusion, and evaluation; and
- `security-operations.md` owns daemon secrets, network exposure,
  audit, redaction, and public-deployment controls.

Memory MUST be able to use embedding and rerank operations without installing or
running the large language model (LLM) conversation extension. Sharing an
endpoint, credential, model name, or adapter family MUST NOT imply that chat,
embedding, and rerank features are interchangeable.

### 1.1 Required principles

1. Features are declared for one exact endpoint/model/operation tuple, not
   guessed from names, Uniform Resource Locators (URLs), software development
   kits (SDKs), or another operation.
2. Persistent descriptors, live bindings, handles, and frozen snapshots remain
   distinct; only the model provider broker receives network and credential authority.
3. Invocations are frozen, bounded, cancellable, and fenced before external
   I/O. Provider output and errors are untrusted.
4. Deterministic fake-provider tests establish conformance; private or paid
   endpoint success does not.

## 2. Configuration and invocation objects

The contract separates four objects that MUST NOT be collapsed.

### 2.1 Descriptor document

A `DescriptorDocument` is immutable, non-secret, canonical JavaScript Object
Notation (JSON). Its
identity key is:

~~~text
(endpointId, operation, modelId, adapterId, adapterVersion,
 descriptorVersion)
~~~

`endpointId` is a logical deployment identifier, not a URL.
`modelId` is the exact semantic value sent at the descriptor's
declared wire location. Each tuple component is a non-empty opaque string except
for the operation discriminant:

~~~typescript
type ModelOperationKind =
  | "chat-completion"
  | "embedding"
  | "rerank";

interface DescriptorRef {
  endpointId: string;
  operation: ModelOperationKind;
  modelId: string;
  adapterId: string;
  adapterVersion: string;
  descriptorVersion: string;
  descriptorDigest: string;
}
~~~

The common conceptual shape is:

~~~typescript
interface DescriptorDocument<TFeatures> {
  schemaVersion: "dolly.model-descriptor/3";
  descriptorVersion: string;
  endpointId: string;
  operation: ModelOperationKind;
  modelId: string;
  adapter: {
    id: string;
    version: string;
    requestStrategyId: string;
    responseStrategyId: string;
    streamStrategyId?: string;
  };
  limits: DescriptorLimits;
  input: DescriptorInput;
  retry: RetryFeatures;
  features: TFeatures;
}

type AnyDescriptor =
  | (DescriptorDocument<ChatFeatures> & {
      operation: "chat-completion";
    })
  | (DescriptorDocument<EmbeddingFeatures> & {
      operation: "embedding";
    })
  | (DescriptorDocument<RerankFeatures> & {
      operation: "rerank";
    });
~~~

Descriptor schema version 3 retains the `features` field introduced in version
2 and removes the former `viewStrategyId` field. A Media reference already
identifies one Media and carries its optional crop, so a descriptor cannot
introduce a second media-view identity. Registries MUST reject versions 1 and 2;
migration creates and validates a new version 3 document instead of accepting
multiple versions at one runtime boundary.

The normative schemas MUST be closed. A descriptor MUST NOT contain endpoint
addresses, routes, proxy settings, secret references or values, authentication
headers, paths, capability handles, media grants, signed URLs, request-specific
state, executable templates, or arbitrary request body fragments.

Provider-specific behavior is selected only through versioned, allowlisted
strategy identifiers. A strategy identifier names reviewed code; it is not code
or authority.

### 2.2 Private endpoint binding

A private endpoint binding is one immutable, host-only configuration revision
that connects a logical `endpointId` and its allowed model descriptors to an
exact network address, authentication secret reference, and finite limits. The
term binding is used because it connects provider-neutral model descriptions to
deployment-specific network authority without exposing that authority to an
Extension. The model provider broker validates that the binding permits the descriptor's exact
operation, model, adapter, and strategy versions.

Endpoint binding version 2 uses `networkScope` to state which addresses the host
may contact. `public` means a public unicast destination; it does not mean that
the endpoint is unauthenticated or publicly readable. This scope requires
Hypertext Transfer Protocol Secure (HTTPS), the platform trust store,
public-unicast results for every Domain Name
System (DNS) answer, a pinned selected address with hostname and Server Name
Indication (SNI) verification, no ambient proxy, identity encoding, and no
redirects. Its exact URL may use a non-default public port only because the
binding is trusted operator state.

`loopback` accepts only an explicit numeric `127.0.0.1` or `::1` Hypertext
Transfer Protocol (HTTP) address with a port and is only for a provider on the
same host. Private-network routes, custom certificate authorities, proxies,
redirects, and Unix or named-pipe transports require separately specified and
reviewed policies; they are not implied by HTTPS or by an endpoint/model name.

The current schema is `dolly.endpoint-binding/2`. Version 1 and its former
`transportProfile` field MUST be rejected rather than treated as aliases.

A binding has an opaque revision. Secret rotation or address failover MAY
create a new revision without changing a descriptor when model semantics and
wire behavior are unchanged. A binding revision is frozen per invocation.

Consumers and adapter codec code MUST NOT receive the binding, raw credentials,
an endpoint HTTP handle, or a generic fetch function. Neither broker nor adapter
may guess or append `/v1`, `/chat/completions`, or another
route suffix.

### 2.3 Model-operation handle

The host issues an opaque, session-local handle bound to:

- one consumer process, Extension process session, instance, and owner/tenant scope;
- one exact descriptor identity and digest;
- allowed operation, modalities, and execution class;
- finite rate, concurrency, byte, item, token, time, and cost limits; and
- expiry, revocation, and data-egress policy.

Possession authorizes only the host-side grant. The handle is not persistent
configuration and MUST NOT expose its binding or underlying authorities.

### 2.4 Frozen invocation snapshot

Before media resolution or provider I/O, the model provider broker freezes:

- descriptor document, schema digest, and descriptor digest;
- adapter implementation and strategy versions;
- endpoint binding revision;
- authorized consumer and Core execution context;
- effective budgets, deadline, cancellation, and retry plan; and
- exact media requirement identifiers and intended provider recipient.

Registry, alias, descriptor, adapter, or binding changes after this point do not
alter the invocation. Emergency revocation MAY cancel it, but late output
remains fenced and the decision MUST be auditable.

## 3. Descriptor registry

### 3.1 Support status

Conditional feature support uses one tagged status:

~~~typescript
type SupportStatus<T> =
  | { state: "supported"; value: T }
  | { state: "unsupported" }
  | { state: "unknown" }
  | { state: "inapplicable" };
~~~

`unknown` is not supported. A request depending on an unknown or
unsupported feature MUST fail before media or network I/O. A required field
cannot be marked inapplicable.

### 3.2 Canonical JSON and digest

Descriptor version 2 uses this digest procedure:

1. validate against the exact closed descriptor schema;
2. reject duplicate keys, invalid Unicode, non-finite numbers, and negative
   zero;
3. encode with the RFC 8785 JSON Canonicalization Scheme as Unicode
   Transformation Format 8-bit (UTF-8) without a byte order mark (BOM) or
   trailing newline;
4. preserve array order and do not normalize or case-fold strings; and
5. compute Secure Hash Algorithm 256-bit (SHA-256) over those bytes.

The external form is `sha256:<64 lowercase hexadecimal characters>`.
`descriptorDigest` is carried beside the document and is not included
in its own input. The registry also publishes the descriptor
`schemaDigest`. Endpoint bindings, aliases, status, handles, discovery
evidence, and validation timestamps are outside the descriptor digest.

### 3.3 Registration and compatibility

The registry stores a descriptor by exact identity and digest. Re-registering
the same identity and bytes is idempotent. Different bytes under the same
identity MUST fail; changed documents require a new
`descriptorVersion`.

Mutable registry status is `active`, `disabled`, or
`superseded`. Aliases map atomically to one exact identity and digest
and are resolved before snapshot creation. Stored provenance never records only
an alias.

Provider discovery creates an unusable candidate until schema validation,
strategy allowlisting, and explicit activation succeed. Wildcards are forbidden
unless every matched model is proven to have the same declared behavior.

A digest change is incompatible by default. A separate registry assertion MAY
name two digests and the exact properties proven compatible. Embedding-vector
reuse additionally requires unchanged vector space, dimension, numeric
decoding, normalization, metric, modalities, and post-processing. Equal
dimensions or model names are insufficient.

## 4. Common descriptor types

Every numeric limit is finite. A missing bound is unknown, not unlimited.
Deployment and capability policy MAY impose lower limits.

~~~typescript
interface DescriptorLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxInputItems: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxConcurrentRequests: number;
  maxProviderTimeoutMs: number;
  streaming: SupportStatus<{
    maxEvents: number;
    maxBufferedBytes: number;
  }>;
}

interface DescriptorInput {
  modalities: readonly string[];
  text: SupportStatus<{
    maxBytesPerItem: number;
    empty: "allowed" | "forbidden";
  }>;
  media: readonly MediaRequirement[];
}

interface MediaRequirement {
  requirementId: string;
  modality: string;
  mimeTypes: readonly string[];
  deliveryModes: readonly MediaDeliveryMode[];
  maxItems: number;
  maxBytesPerItem: number;
  maxAggregateBytes: number;
  providerFetchesAfterAcceptance: boolean;
  lifetimeStrategyId: string;
  placementStrategyId: string;
}

interface RetryFeatures {
  maxProviderAttempts: number;
  safeConditions: readonly (
    | "before-dispatch"
    | "rate-limited"
    | "transient-server-failure"
    | "transport-not-accepted"
  )[];
  providerIdempotency: SupportStatus<{
    strategyId: string;
    outcomeQueryStrategyId?: string;
  }>;
}
~~~

`MediaDeliveryMode` describes how the host may supply bytes to a provider. A
media reference is the same closed Block content item defined in
`block-payload.md`: it identifies one registered Media by `mediaId` and may
carry the same crop, caption, or accessibility metadata. `MediaReferenceItem`
is the TypeScript name for that complete item; the suffix distinguishes it from
the `mediaId` string alone. Model input reuses this Block type so it cannot
substitute a provider URL, base64 payload, object-storage key, or an
adapter-specific handle.

The optional crop remains part of that exact `MediaReferenceItem`. The model provider broker
and adapter MUST preserve it exactly or reject the request; they MUST NOT create
or select a separate media view.

Provider adapters use bounded codecs. They accept normalized input and frozen
descriptor data, return a provider request or normalized result, reject
unknown fields, and have no ambient filesystem, process, secret, or network
authority. Arbitrary headers, URLs, provider objects, callbacks, and request
body merges are forbidden.

## 5. Common invocation contract

### 5.1 Request and budgets

~~~typescript
interface ModelInvocationRequest<TInput> {
  requestId: string;
  operation: ModelOperationKind;
  descriptorDigest: string;
  context: InvocationContext;
  budgets: InvocationBudgets;
  input: TInput;
}

interface InvocationContext {
  operationId: string;
  instanceId: string;
  ownerScope: string;
  moduleId?: string;
  moduleGenerationId?: string;
  moduleJobId?: string;
  runId?: string;
  attempt?: number;
  sessionId?: string;
  conversationId?: string;
  backgroundJobId?: string;
  idempotencyKey?: string;
  deadline: string;
}

interface InvocationBudgets {
  maxProviderAttempts: number;
  maxWallTimeMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxInputItems: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxMediaItems?: number;
  maxResolvedMediaBytes?: number;
  maxCost?: { currency: string; decimalAmount: string };
}
~~~

The generic interface above shows fields shared by concrete operations; it has
no wire schema of its own. Chat and embedding use the exact schemas
`dolly.model.chat-invocation/3` and
`dolly.model.embedding-invocation/3`. Version 3 replaces version 2
`processingId` with `moduleJobId`. It also retains `moduleId`, the stable
identity of one configured Module, instead of the removed version 1
`moduleInstanceId`. Brokers MUST reject version 2 and earlier before provider
input/output, secret resolution, or network access; removed fields are not
aliases.

`requestId` uniquely identifies one call to Dolly's provider-request service.
Another service call uses another `requestId`, even when it belongs to the same
logical operation. `operationId` identifies that upper-level logical operation
and MAY remain unchanged across service calls and retries.

`InvocationContext.attempt` is the upper-level Module work retry number. It is
not a provider dispatch count. `idempotencyKey` is the caller-supplied stable
key for provider duplicate suppression; retries of the same provider operation
keep it unchanged, and the model provider broker may transmit it only through the descriptor's
declared provider-idempotency strategy.

The host supplies or verifies authority-bearing context. A Module invocation
must match the active `moduleGenerationId`,
`moduleJobId`, `runId`, and attempt. Effective budgets
are the strictest intersection of descriptor, grant, deployment, Core run,
media policy, and request limits. Retries and media preparation consume the
same budgets; they do not reset them.

Money uses a validated decimal string. Unknown usage or cost is not zero. When
a required finite budget cannot be enforced, the model provider broker rejects the request
before I/O.

### 5.2 Result, usage, and errors

~~~typescript
interface ModelInvocationResult<TOutput> {
  schemaVersion: "dolly.model-result/2";
  requestId: string;
  operationId: string;
  providerRequestId?: string;
  descriptor: DescriptorRef;
  status: "succeeded" | "partial" | "failed" | "cancelled";
  output?: TOutput;
  error?: ModelOperationError;
  usage: ModelUsage;
}

interface ModelUsage {
  providerAttempts: number;
  observations: readonly {
    name: string;
    state: "observed" | "unknown" | "unavailable";
    source?: "provider" | "broker-estimate";
    value?: number | string;
    unit?: string;
  }[];
}

type RetryClass =
  | "never"
  | "same-snapshot-before-deadline"
  | "after-bounded-backoff"
  | "after-reconfiguration"
  | "indeterminate";

type ModelErrorCode =
  | "INVALID_REQUEST"
  | "CAPABILITY_DENIED" | "CAPABILITY_REVOKED"
  | "CAPABILITY_UNKNOWN" | "FEATURE_UNSUPPORTED"
  | "DESCRIPTOR_NOT_FOUND" | "DESCRIPTOR_DIGEST_MISMATCH"
  | "DESCRIPTOR_DISABLED" | "BINDING_UNAVAILABLE" | "ADAPTER_UNAVAILABLE"
  | "BUDGET_EXCEEDED" | "RATE_LIMITED" | "MEDIA_ERROR"
  | "AUTHENTICATION_FAILED" | "PROVIDER_REJECTED" | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL_ERROR" | "PROVIDER_PARTIAL_RESULT"
  | "INVALID_VECTOR" | "INVALID_SCORE" | "OUTPUT_LIMIT_EXCEEDED"
  | "DEADLINE_EXCEEDED" | "CANCELLED"
  | "INDETERMINATE_REMOTE_OUTCOME" | "INTERNAL_ERROR";

interface ModelOperationError {
  code: ModelErrorCode;
  phase:
    | "authorization"
    | "validation"
    | "media"
    | "dispatch"
    | "response"
    | "cleanup";
  retryClass: RetryClass;
  message: string;
  retryAfterMs?: number;
  itemId?: string;
}
~~~

`providerRequestId` is present only when the provider actually returned a
syntactically valid `requestId`. When the provider returns no valid identifier, the field
is omitted; a sentinel such as `"unavailable"` is forbidden.

`usage.providerAttempts` is the number of provider transport dispatches
actually attempted during this provider-request-service call. It is independent
of the upper-level Module work retry number in `InvocationContext.attempt`.

Result schema version 2 introduces the optional `providerRequestId` contract.
Consumers MUST reject result schema version 1 instead of treating a sentinel
value as a provider-issued identifier.

`MEDIA_ERROR` has code-specific closed details distinguishing denied,
unavailable, and over-limit outcomes. Other structured details likewise require
a versioned closed schema; raw provider error objects are forbidden.

Field combinations are closed:

- `succeeded` requires output and forbids error;
- `partial` is valid only for item operations, requires one terminal
  outcome per requested item, and carries a provider-partial summary error;
- `failed` requires error and forbids output; and
- `cancelled` requires a cancellation or deadline error and forbids
  output.

Usage is present in every terminal result. Provider observations and broker
estimates remain labeled; unavailable values are not converted to zero.
Errors and usage MUST be bounded and redacted under
`security-operations.md`.

### 5.3 Cancellation, idempotency, and retry

Cancellation stops new preparation, dispatch, and retry; signals active
transport; fences late output; and returns one terminal result. It does not
claim that an uncertain remote request never executed. Media leases remain
valid until provider access actually ends or expires, as required by
`media.md`.

Provider duplicate suppression uses the caller's stable `idempotencyKey` only
when the frozen descriptor declares the matching provider mechanism.
Core-derived work SHOULD use stable `moduleJobId` plus an effect slot or
durable item or job identifier.
`runId` alone is insufficient.

The model provider broker MUST NOT claim exactly-once provider execution. An uncertain accepted
request without proven provider idempotency or outcome query returns an
indeterminate error. Retry classification does not command a retry: remaining
deadline, attempts, rate, cost, cancellation, and duplicate risk still apply.
Validation, authorization, authentication, unsupported feature, exhausted
budget, invalid vector, and invalid score failures are not automatic retries.

## 6. Chat-completion

### 6.1 Features

~~~typescript
interface ChatFeatures {
  roles: readonly string[];
  messageOrderStrategyId: string;
  maxMessages: number;
  maxPartsPerMessage: number;
  contextWindowTokens: SupportStatus<{ maximum: number }>;
  maxOutputTokens: SupportStatus<{ maximum: number }>;
  mediaRequirementIds: readonly string[];
  tools: SupportStatus<{
    maxDefinitions: number;
    maxArgumentBytes: number;
    parallelCalls: boolean;
    strategyId: string;
  }>;
  structuredOutput: SupportStatus<{
    dialectId: string;
    maxSchemaBytes: number;
    strategyId: string;
  }>;
  reasoning: ReasoningWireFeatures;
  finishReasons: readonly string[];
}
~~~

The descriptor describes provider wire features only. The LLM extension selects
conversation events, trusted roles, tools, output contracts, reasoning
policy, and turn commit. The model provider broker MUST NOT promote content to a trusted role
based on text or payload shape.

### 6.2 Minimal broker I/O

The `mediaReference` field uses the strict Block media reference defined in
Section 4.

~~~typescript
type ChatPart =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaReference: MediaReferenceItem;
      requirementId: string;
    };

interface ChatInput {
  schemaVersion: "dolly.model.chat-input/2";
  messages: readonly {
    role: string;
    parts: readonly ChatPart[];
  }[];
  tools?: readonly {
    name: string;
    description?: string;
    inputSchema: JsonValue;
  }[];
  outputContract:
    | { kind: "text" }
    | { kind: "json-schema"; schema: JsonValue };
  reasoning: ReasoningWireDirective;
  stream: boolean;
}

interface ChatOutput {
  schemaVersion: "dolly.model.chat-output/1";
  finalContent: string;
  reasoning: ReasoningObservation;
  toolCalls: readonly {
    callId: string;
    name: string;
    arguments: JsonValue;
  }[];
  finishReason: string;
}
~~~

The normative schema is closed and validates roles, schema dialect, limits,
tool names, finish reasons, and media requirement identifiers against the frozen
descriptor. Provider adaptation operates on a copy and cannot mutate canonical
conversation, Block, tool, or media state.

Version 2 replaces the former arbitrary `mediaRef` value with the strict
`mediaReference` Block item and removes `attachmentSlot`. Version 1 and either
removed field MUST be rejected; there is no implicit compatibility conversion.

### 6.3 Reasoning wire contract

~~~typescript
interface ReasoningWireFeatures {
  support: "unsupported" | "always-on" | "request-controlled";
  requestControl:
    | { kind: "forbidden" }
    | { kind: "boolean-strategy"; strategyId: string }
    | { kind: "enum-strategy"; strategyId: string }
    | { kind: "adapter-strategy"; strategyId: string };
  observation: SupportStatus<{
    nonStreamStrategyId?: string;
    streamStrategyId?: string;
    empty: "not-observed" | "observed-empty";
  }>;
  replay: {
    requirement:
      | "forbidden"
      | "allowed"
      | "required-for-tool-continuation";
    strategyId?: string;
  };
}

type ReasoningWireDirective = "omit" | "enable" | "disable";

type ReasoningObservation =
  | { state: "observed"; parts: readonly string[] }
  | { state: "not-observed" }
  | { state: "unavailable" };
~~~

The LLM extension maps its reasoning policy to a wire directive. The model provider broker validates
that directive and uses only the declared strategy. It MUST NOT add a field
because another model accepts it. Reasoning observation stays separate from
final content, tool calls, and usage. The LLM extension decides whether missing
reasoning satisfies policy, whether it is displayed, and how it is retained.

Replay input is accepted only under the declared requirement and strategy.
Reasoning MUST NOT be concatenated into final content to bypass replay or
observation rules.

### 6.4 Streaming

Stream events carry broker `requestId`, a monotonic base-10 event sequence,
channel kind, and bounded payload. The adapter preserves reasoning, final
content, tool-call, usage, and terminal channels; tolerates arbitrary transport
fragmentation; rejects duplicate, regressing, malformed, oversized, or
post-terminal events; and produces one terminal result. Cancellation or
disconnect cannot turn partial streamed text into a successful output.

## 7. Embedding

### 7.1 Features

~~~typescript
interface EmbeddingFeatures {
  itemKinds: readonly ("text" | "media" | "multimodal")[];
  mediaRequirementIds: readonly string[];
  compositeStrategyIds: readonly string[];
  dimensions:
    | { kind: "fixed"; value: number }
    | { kind: "allowed"; values: readonly number[] };
  numericEncoding: string;
  decodeStrategyId: string;
  maxBatchItems: number;
  maxPartsPerItem: number;
  normalization:
    | { kind: "not-normalized" }
    | { kind: "unit"; tolerance: number };
  metric:
    | { kind: "cosine" }
    | { kind: "dot-product" }
    | { kind: "euclidean" }
    | { kind: "declared"; semanticsId: string };
  vectorSpaceId: string;
  comparableModalitySets: readonly (readonly string[])[];
  perItemErrors: SupportStatus<{
    correlation: "item-id" | "position";
  }>;
  postProcessing: SupportStatus<{ strategyId: string }>;
}
~~~

Text-only embedding is valid. It rejects direct unsupported media before
resolution or provider I/O. The model provider broker MUST NOT substitute hashes, zero vectors,
mocks, optical character recognition (OCR), captions, or another model. A
derived text pipeline is an explicit
consumer policy and retains its own provenance.

### 7.2 Closed item contract

~~~typescript
type EmbeddingPart =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      modality: string;
      mediaReference: MediaReferenceItem;
      requirementId: string;
    };

type EmbeddingItemInput =
  | EmbeddingPart
  | {
      kind: "multimodal";
      parts: readonly EmbeddingPart[];
      compositeStrategyId: string;
    };

interface EmbeddingInput {
  schemaVersion: "dolly.model.embedding-input/2";
  outputDimension: number;
  items: readonly {
    itemId: string;
    input: EmbeddingItemInput;
  }[];
}

type EmbeddingItemOutcome =
  | {
      itemId: string;
      status: "succeeded";
      vector: readonly number[];
      dimension: number;
      vectorSpaceId: string;
    }
  | {
      itemId: string;
      status: "failed";
      error: ModelOperationError;
    };

interface EmbeddingOutput {
  schemaVersion: "dolly.model.embedding-output/1";
  items: readonly EmbeddingItemOutcome[];
}
~~~

Embedding input version 2 applies the same strict `mediaReference` contract.
Version 1 and the removed `mediaRef` field MUST be rejected; an adapter cannot
interpret an arbitrary JSON object as a Media identity or access grant.

`outputDimension` is mandatory even for a fixed-dimension descriptor. It MUST
equal that fixed value or one of the descriptor's allowed values. This prevents
an adapter or provider default from silently choosing a vector shape. A
`multimodal` item is valid only when its `compositeStrategyId` appears in the
frozen descriptor's `compositeStrategyIds`; a descriptor that does not support
multimodal items declares an empty list. Provider/model names are never a
substitute for either declaration.

Input `itemId` values are unique, bounded, and opaque. The model provider broker
returns exactly one terminal outcome per requested item in request order.
Position-only protocols map against the frozen order. Duplicate, foreign,
ambiguous, or missing provider items are protocol errors.

Reliable successes MAY be preserved when other items fail. Every missing item
then receives a typed failure and the invocation is partial; an incomplete
batch is never complete. A structurally uncorrelatable response fails the whole
invocation.

### 7.3 Vector validation

Before success, the model provider broker verifies that every decoded element is finite, the
dimension is declared, encoding and normalization match, and the result uses
the descriptor's exact vector space and metric. It never pads, truncates,
reorders, or silently normalizes a vector. Declared post-processing is
versioned and included in provenance.

Equal dimensions do not establish compatibility. Stored and query vectors
record descriptor identity/digest, operation, vector-space identifier, dimension,
encoding, normalization, source modality, and consumer-owned transform
provenance.

## 8. Rerank

### 8.1 Features

~~~typescript
interface RerankFeatures {
  inputKind: "text";
  maxDocuments: number;
  maxQueryBytes: number;
  maxDocumentBytes: number;
  maxAggregateDocumentBytes: number;
  maxTopK: number;
  resultMode: "all-items" | "top-k";
  score: {
    direction: "higher-is-better" | "lower-is-better";
    range?: { minimum: number; maximum: number };
    calibrationId?: string;
  };
  perItemErrors: SupportStatus<{
    correlation: "item-id" | "position";
  }>;
}
~~~

The descriptor cannot call a score a probability or compare it across
descriptors without a versioned calibration proving that interpretation.

### 8.2 Closed item contract

~~~typescript
interface RerankInput {
  schemaVersion: "dolly.model.rerank-input/1";
  query: string;
  documents: readonly { itemId: string; text: string }[];
  topK?: number;
}

type RerankItemOutcome =
  | {
      itemId: string;
      status: "scored";
      score: number;
      providerRank?: number;
    }
  | { itemId: string; status: "not-returned" }
  | {
      itemId: string;
      status: "failed";
      error: ModelOperationError;
    };

interface RerankOutput {
  schemaVersion: "dolly.model.rerank-output/1";
  scoreSemantics: {
    direction: "higher-is-better" | "lower-is-better";
    range?: { minimum: number; maximum: number };
    calibrationId?: string;
  };
  items: readonly RerankItemOutcome[];
}
~~~

Document identifiers are unique and correlate exactly once. Scores are finite and
inside a declared range. `not-returned` is valid only for a declared
top-k response and is not a zero score. Missing all-items results become typed
partial failures. Fusion, fallback, thresholds, and tie-breaking belong to the
consumer and remain separately versioned.

## 9. Media and transport boundary

### 9.1 Provider access for Media

A consumer submits only an authorized `MediaReferenceItem` and a requirement identifier
from the fixed model description. The reference contains `mediaId` and an
optional logical crop; it cannot contain a raw path, URL, base64 value,
object-store key, provider file identifier, access grant, or broader access mode.

`mediaId` is shared by trusted Core components within one Dolly instance so
Blocks can forward a Media reference, but it is not authority for an Extension.
Before a consumer can submit this item, the host must derive and verify a
delivered-Block-scoped Media capability for the authenticated Module job. The
model provider broker may then resolve the
validated reference; an Extension cannot invoke `MediaStore` or turn a guessed
identifier into a provider grant. The Extension-process Media capability is not
yet wired, so this requirement describes the future boundary rather than a
current isolated-Extension feature.

The model provider broker asks the Media store for the exact Media and
crop, provider recipient, deadline, accepted access modes, and remaining
budgets. This request is the source value `ProviderAccessRequest`. The Media
store chooses the allowed access mode and returns the source value
`MediaAccessGrant`; it also records any URL grant's associated access lease in
a provider access record for cleanup and recovery.

For a URL grant, the model provider broker reports the result through
`recordProviderAccessOutcome` with the exact lease, request, and recipient
identifiers. `not-sent` and `finished` release the lease; a
`fetch-status-unknown` result retains it. A private signed URL expiring is not
itself a result. Public URL grants are disabled unless the host explicitly
enables them. An inline grant is a verified copied byte value and does not
create a provider access record or persistent lease.

Adapter code may serialize one host-provided temporary input into the current
provider request. It receives no Media access permission or lease and cannot
resolve, refresh, publish, retain, or independently use the grant. Consumer
state, model descriptions, cache keys, provenance, and normal logs contain only
Media references, never the temporary provider input.

The model provider broker MUST NOT construct object-store or crop URLs,
change a private object to public, or substitute the original Media when a crop
was requested. Access-lease release, an uncertain remote fetch, retry refresh,
deletion permission, and recovery follow `media.md`.

### 9.2 Host-only provider transport

Only the model provider broker resolves endpoint configuration, opens
model endpoint connections, attaches authentication, and authorizes
provider-facing Media use. A consumer
cannot supply provider destinations, routes, headers, credentials, proxies,
redirects, Transport Layer Security (TLS) settings, SDK clients, or arbitrary
provider fields.

An adapter encodes a bounded provider request. The model provider broker verifies
the adapter digest, method, exact route, content type, allowed headers, serialized sizes,
media grant origin, timeout, and response limits before attaching
authentication. Multi-request upload/poll/inference workflows remain one
bounded invocation and consume its budgets.

Network destination, DNS, redirect, TLS, decompression, rate, isolation, and
redaction requirements are not restated here; the model provider broker MUST enforce
`extension-process-protocol.md`, `media.md`, and
`security-operations.md`. A provider-returned URL never authorizes a
fetch.

If an adapter library requires direct credentials or unrestricted networking,
it does not conform to this provider-request contract. Running it as an explicitly
privileged deployment exception MUST NOT be presented as public-extension or
shared provider-request conformance.

## 10. Conformance tests

### 10.1 Deterministic provider protocol suite

Every registry, descriptor schema, provider adapter, and model provider broker implementation
MUST pass local deterministic tests. Tests inspect exact outbound route,
headers, canonical body or frames, normalized output, retry timing, and media
cleanup. A non-null response or plausible answer is insufficient.

The required suite covers:

- closed schemas, support statuses, JSON Canonicalization Scheme and SHA-256
  vectors, digest mismatch,
  aliases, and frozen snapshots across concurrent updates;
- document/binding/handle separation and absence of endpoint or secret
  authority from consumer-visible data;
- exact route construction, broker-only authentication, limits, cancellation,
  stale generation, late response, idempotency, retry classification, usage,
  and redaction;
- chat roles and ordering, every reasoning control/observation/replay mode,
  channel-separated stream fragmentation, tools, structured output, and all
  declared media mappings;
- embedding text/media feature rejection, batch splitting, item correlation,
  partial/missing results, malformed encodings, dimensions, normalization,
  vector-space provenance, and prohibition of fabricated fallbacks;
- rerank item correlation, all-items/top-k behavior, partial results, finite
  score/range/direction/calibration semantics; and
- exact Media reference and crop handling, grant secrecy, private signed URL
  expiry without automatic cleanup, public-URL default denial, inline-copy
  behavior, request-outcome fencing, cancellation, restart, and lease cleanup
  only after trusted completion.

Fixtures use fake endpoint/model identities, clocks, identifiers, media, usage, vectors,
and scores. No internet, private endpoint, account, credential, model download,
or billable request is required. A fake result MUST NOT use real descriptor
provenance.

### 10.2 Controlled live and paid fixtures

A live provider test runs only when:

- `RUN_LIVE_INTEGRATION=1` is explicitly set;
- one named fixture and exact descriptor digest are selected;
- approved endpoint and secret bindings are available through the model provider broker;
- finite request, attempt, byte, token/item, time, egress, and cleanup limits
  are configured; and
- test data allowed to leave the machine is declared.

A potentially billable fixture additionally requires
`RUN_PAID_INTEGRATION=1` and a finite monetary budget. An API key,
endpoint, descriptor, or `.env` file never activates live tests.
Default tests and continuous integration (CI) skip them without opening a
provider connection.

A selected live test fails non-zero on assertion, provider, timeout, invalid
output, budget, or cleanup failure. It MUST NOT silently switch provider/model,
downgrade modality, or fall back to a mock while retaining a real label.

The owner's Aether `qwen3.6-27b` chat fixture is OPTIONAL. Its exact
wire test asserts that `enable_thinking` is absent and that cases
claiming reasoning observe non-empty `reasoning_content`, including
separate streaming accumulation.

The owner's Bailian/DashScope vision-language (VL) embedding fixture is OPTIONAL. Its descriptor
declares native text/image support, delivery modes, dimensions, encoding,
normalization, metric, vector space, and cross-modal compatibility. The test
verifies exact item correlation, vectors, provenance, no derived text or mock
substitution, and media grant cleanup. Object Storage Service (OSS) signing, lifecycle, and required
read/write/delete permission checks remain owned by `media.md`.

Named fixtures are not product defaults or conformance dependencies. Published
evidence records code revision, descriptor digest, adapter versions, exact
model identifier, usage source, and sanitized outcome, without private endpoints,
secrets, grants, prompts, media, vectors, reasoning, or rerank documents.

## 11. Cross-document invariants and conformance

1. Ordinary model consumers receive a model operation handle, never generic
   model endpoint HTTP or credential authority.
2. LLM consumes chat features; Memory consumes embedding/rerank directly.
   Neither operation acquires another extension's session semantics.
3. Descriptors declare media requirements; only Media grants access.
4. Temporary grants and provider wire objects never enter canonical product
   state.
5. Provider, model, endpoint, or vector compatibility is explicit and
   descriptor-bound, never inferred by name or dimension.
6. Cancellation, generation fencing, AccessLease lifetime, process-protocol capability
   scope, and public security retain their owning specifications.

A conformance claim records this specification revision, Extension process protocol/Core
revisions, descriptor schema and digest, adapter implementation versions, and
fake-suite revision. No required deterministic test may be skipped. Optional
live success is reported separately and cannot compensate for a fake-suite
failure.

Adopting this Draft moves generic provider, embedding, rerank, binding, and
ownership of the exact provider protocol out of `llm-extension.md`. Consumer
specifications should reference this contract rather than duplicate transport,
signing, retry, or live-test rules.
