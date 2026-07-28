# Architecture Decision Record 0006: Shared Model Provider Broker

Status: Proposed

Date: 2026-07-24

## Context

Chat, embedding, and reranking need the same endpoint security, capability,
budget, cancellation, Media-access, and adapter-conformance boundary. Keeping
embedding inside the LLM conversation extension would make Memory depend on an
unrelated session implementation and would let extensions bypass provider policy
through generic HTTP.

## Proposed decision

- Dolly owns one trusted model provider broker. It is platform infrastructure,
  not a conversation extension or a provider-specific SDK facade.
- A versioned descriptor document identifies one exact endpoint/model/operation
  and verified capabilities. It is immutable, canonically hashed, safe to retain
  as provenance, and separate from the runtime endpoint binding and opaque
  operation handle.
- `chat-completion`, `embedding`, and `rerank` are distinct operations with
  operation-specific closed request/result contracts. Sharing a credential,
  endpoint, model name, dimension, or provider brand does not imply
  compatibility.
- Ordinary LLM and Memory extensions receive only descriptor-bound model
  operation handles. The model provider broker alone receives model endpoint network authority,
  authentication bindings, and media provider grants.
- Media has one Core-managed identifier, `mediaId`, within a Dolly instance;
  crops are request data rather than
  asset or view identities. The trusted Media store issues a provider access
  grant and retains the associated access lease in a provider access record.
  The model provider broker requests that grant and never makes a signed URL or provider
  upload handle part of canonical extension state. A URL grant remains retained
  until the model provider broker records a matching trusted request outcome; signed-URL expiry
  alone is not a completion signal. Inline Media bytes are a copy and do not
  create a persistent provider access record.
- Every provider adapter must pass deterministic exact-wire fake tests. Private
  Aether, DashScope/Bailian, OpenAI-compatible, or other live deployments are
  optional fixtures selected only by explicit live/paid test controls.

## Consequences

Memory can use text or multimodal embedding and optional reranking without
depending on LLM conversation state. LLM can concentrate on turns, prompt trust,
tools, and output. Provider adapters require more explicit descriptors and
broker code, but credentials, routing, media disclosure, and budgets have one
enforceable authority boundary.

## Required conformance evidence

Tests must verify descriptor/binding separation, unknown capability rejection,
operation isolation, exact route and request construction, item correlation and
partial batches, finite vector/score validation, reasoning control/observation,
broker-only network and credential access, media grant cleanup, retry and
cancellation fencing, fake/real identity separation, and explicit live/paid
selection. No private endpoint or billable call is required for conformance.
