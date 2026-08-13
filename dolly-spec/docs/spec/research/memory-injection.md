# Memory Context Selection Research Specification

Status: **Experimental selection policy with a stable transport and trust boundary**.
Stable explicit Memory search and ordinary recall Blocks MUST work when every
automatic-selection mechanism in this chapter is disabled.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for the experiment and its safety boundary.

`REQ-INJECT-001` — A Memory context-selection experiment or promoted policy
MUST preserve query-basis self-exclusion, same-request identity deduplication,
cross-request repeat eligibility, typed external evidence, immutable decisions,
attempt-level rate limiting, equal-budget evaluation, and rollback to explicit
search without changing stable Memory records.

## 1. Retrieval and context selection are different operations

Retrieval finds authorized candidate records from a frozen Memory snapshot.
Context selection decides which retrieved records, if any, become evidence in
one particular model request. The implementation MUST keep these operations
separate:

```text
committed Blocks -> explicit or automatic search -> candidate result
                 -> context-selection decisions -> canonical model request
```

The stable `org.dolly.memory.search` result does not consult earlier context
selection. For identical validated arguments, effective query basis, index
revision, and authorized corpus, it produces the same ordered result. Automatic
selection MAY use earlier presentation metadata only through a separately
versioned experimental policy.

“Injection” in this chapter means inclusion of a Memory record in one canonical
model request. It does not mean editing a prompt string, Module Descriptor,
Memory record, or source Block.

## 2. Stable carrier and prompt authority

Memory search and recall output is always committed through the ordinary Block
and Activation path. A dynamic Memory record MUST NOT be stored in Premise.
Premise remains the deterministic text projection of the frozen Module
Descriptor and may describe how to request Memory, but it cannot contain the
result of a request.

When a selected record enters a model request, the LLM Extension MUST create a
`MemoryEvidencePart` conforming to `schemas/model-request.schema.json`. The
containing canonical message MUST use `role_class: external`. The part contains
the exact selected search-result record and its `include` decision. The Memory
identity, revision, retrieval ID, and digests in the decision MUST match the
retained search result from which the record was selected.

A provider adapter MAY encode `external` evidence as a delimited user- or
tool-level provider message according to a frozen adapter profile. It MUST NOT
compile it as a system/developer message or concatenate it with trusted Premise.
The canonical order is:

1. frozen system policy and trusted Descriptor projections;
2. earlier retained conversation entries in their canonical order;
3. selected Memory evidence as one or more `external` entries; and
4. the current task input as the final `external` entry.

Provider constraints MAY require adjacent external entries to be combined, but
the adapter MUST preserve a visible boundary, the low trust class, source
identity in audit, and the relative order above. Recalled text that says to
ignore policy, grant a capability, call a tool, reveal another namespace, or
change configuration remains inert evidence.

## 3. Effective query basis and self-exclusion

For each search Action, the Memory Module constructs one effective query-basis
set as the union of:

- the committed Block containing that Action;
- every source Block in the frozen Activation input Manifest;
- every ID in the validated `query_basis_block_ids` argument; and
- every earlier Block that a first-party query compiler expanded into the
  query text or media input.

The last category is supplied by the compiler through
`query_basis_block_ids`; omitting it is a compiler conformance failure. The set
is deduplicated and sorted by lowercase UUID text. Its digest is:

```text
sha256(JCS({"source_block_ids": <sorted effective set>}))
```

Before scoring, retrieval MUST reject every Memory record whose
`source_block_ids` intersects this set. The same filter applies to context
expansion and association expansion. Filtering after top-k is not equivalent
because it changes candidate depth and may leak rank or existence.

The Memory ingestion path independently rejects:

- a Block produced by the same Memory Module instance;
- a Memory search, recall, context-decision, or Memory-evidence control value;
- text copied from a recall result merely because another Module repackaged the
  control value; and
- an already admitted source/extractor/chunk identity.

The first two rules are hard provenance rules. A semantic-similarity heuristic
MUST NOT decide whether content is “self,” because false positives would erase
legitimate repeated user statements and false negatives would permit loops.

## 4. Three different forms of repetition

Implementations MUST distinguish these cases:

| Scope | Required behavior |
| --- | --- |
| Repeated Delivery of one source Block to Memory | record another occurrence if required by Page semantics; reuse the same compatible extracted record and feature work |
| Same Memory record nominated more than once for one target model request | include at most once by `(memory_id, record_revision)`; every later nomination is `suppress/duplicate_in_target_request` |
| Same Memory record nominated for a later target model request | remain eligible; decide again from the new frozen context and policy |

Two semantically similar but independently sourced records are not exact
duplicates. A policy MAY diversify or collapse them only as an explicit,
versioned treatment with source-preserving output. It MUST NOT silently replace
identity deduplication with embedding-distance deduplication.

The exact same target `request_id` is idempotent. Reassembly after a retry MUST
recover the same ordered Memory evidence and the same decision IDs; it MUST NOT
append a second copy.

## 5. No time-only per-record ban

A policy MUST NOT implement “once per day,” “never again within N hours,” or
any other elapsed-time-only rule that makes a record ineligible. Local date,
day boundary, and wall-clock timezone do not define relevance.

Time since prior presentation and prior presentation count MAY be observable
features. They may lower or raise an experimental selection score, but a repeat
remains representable and auditable. An included record with a nonzero prior
model-request count uses one of these reasons:

- `repeat_relevant_to_current_context`;
- `record_revision_changed`; or
- `explicit_consumer_request`.

The first presentation uses `first_relevant_delivery`. A policy may suppress a
candidate as `repeat_not_useful`, but that outcome must be tied to its frozen
query, policy, and target request rather than to a global timestamp rule.

An automatic-search attempt limiter is separate. Configuration uses a minimum
interval between automatic retrieval attempts plus finite per-minute and
per-Activation attempt budgets. Hitting the limiter suppresses or delays the
automatic attempt as a whole. It MUST NOT write a per-record “next eligible”
time, affect explicit searches, or be called evidence that a record is stale.

## 6. Immutable context-selection decision

Every candidate considered for a model request produces an immutable decision
conforming to `schemas/memory-injection-decision.schema.json`. The record binds:

- decision, target Activation, target Module, and target model-request IDs;
- retrieval, Memory, and record-revision IDs;
- the canonical search-result, effective-query, and query-basis digests;
- exact policy ID and revision;
- count and time of prior canonical model requests containing that Memory
  identity; and
- `include` or `suppress` plus a closed reason.

`prior_model_request_count` counts earlier canonical requests accepted by the
Model Gateway that contained the same `(memory_id, record_revision)`. It does
not assert that a provider read the content or that the content was useful. A
provider timeout or unknown outcome remains an ordinary Model Gateway audit
fact and MUST NOT be converted into positive Memory feedback.

Decisions contain no recalled text. They are prepared with the canonical model
request and become visible only if the LLM Module commits the request intent.
A crash or replay with the same target request ID returns the same decision.
Reusing a decision ID with different bytes is an integrity error.

Suppressed candidates do not appear in `messages`. Included candidates appear
exactly once and carry their matching decision. The LLM Extension MUST reject a
model request if a Memory-evidence part has a suppress decision, mismatched
identity/digest, wrong target request, non-external role, or duplicate Memory
identity.

## 7. Budget and selection order

For a frozen candidate result, the selection policy applies this order:

1. authorization, tombstone, validation-state, and query-basis filtering;
2. exact same-request identity deduplication;
3. frozen retrieval threshold and optional promoted reranking;
4. context-selection policy, including repeat features;
5. deterministic diversity treatment, if enabled;
6. token/byte budget; and
7. stable tie break by retrieval rank, source sequence, then Memory ID.

Rejected candidates remain visible in privileged diagnostics through their
decision reason. A budget cutoff MUST NOT masquerade as low relevance. The
policy MUST be able to return no Memory evidence.

## 8. Feedback and self-reinforcement

Selection, canonical request inclusion, provider dispatch, model citation,
user confirmation, and downstream task success are different events. Merely
including a record MUST NOT increment a baseline importance, retention,
relevance, or access-count boost.

An experiment MAY use explicit downstream feedback only when it defines the
event source, attribution window, negative evidence, delayed outcomes, and
confounding controls. It MUST compare against a variant with presentation
history disabled. Learned feedback state is derived experimental state and can
be discarded without changing stable Memory records or indexes.

## 9. Evaluation and promotion

The preregistered comparison MUST include at least:

1. no automatic Memory context;
2. relevance-only selection with same-request exact deduplication;
3. a hard per-record cooldown baseline, retained only as a comparison;
4. count/time repeat features without a hard ban;
5. the proposed context-sensitive repeat policy; and
6. an oracle upper bound where the needed Memory identities are known.

All variants use the same retrieval candidates and maximum token budget.
Required tasks include repeated questions in one day, an unresolved multi-turn
task, a corrected Memory revision, irrelevant recurring chatter, duplicate
Page routes, a recall Block looping back, adversarial prompt text, and cases
where no Memory should appear.

Primary metrics are downstream task correctness and false-Memory use. Required
diagnostics are exact-duplicate rate per request, useful-repeat recall,
unnecessary-repeat rate, self-match rate, abstention, added tokens, latency,
attempt-limit suppressions, prompt-authority violations, and performance by
prior-presentation count.

Promotion requires held-out improvement over relevance-only selection, no
regression beyond the declared tolerance on ordinary queries, zero self-match
and high-authority placement violations, bounded cost, and a passing rollback
test. The accepted ADR must name the selected policy revision. Until then,
automatic selection remains disabled by default.

## 10. Conformance and adversarial cases

Tests MUST cover at least:

- current Action Block, current Activation inputs, and declared earlier query
  basis all excluded before ranking;
- self-produced recall/control Blocks never ingested, including through a
  self-loop Page;
- duplicate nominations from two Pages included once in one model request;
- the same record legitimately included in a second request minutes later;
- a same-day hard-ban implementation rejected;
- explicit search unchanged by prior model-request count;
- record revision change distinguishable from same-revision repetition;
- prompt-injection text remaining typed `external` evidence;
- mismatched decision/search digests and target request IDs rejected;
- retry/reassembly producing identical evidence and decision IDs;
- no-match and all-suppressed requests producing no Memory evidence; and
- automatic-policy disablement restoring explicit-only behavior without
  migrating or rewriting stable records.
