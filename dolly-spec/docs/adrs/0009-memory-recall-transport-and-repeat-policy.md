# ADR 0009: Carry recalled memory as Blocks and make repetition context-sensitive

- Status: Accepted
- Scope: Memory retrieval, LLM context assembly, and automatic recall research
- Compatibility: clarifies the stable trust boundary and replaces the draft
  per-record cooldown interpretation
- Affected requirements: `REQ-MEM-002`, `REQ-MEM-003`, `REQ-INJECT-001`

## Context

The owner clarified that Memory must ignore the material being used as its own
query, but must not enforce a rule such as “one fragment may be injected only
once per day.” The same evidence can be necessary in several model requests,
especially while a task is unresolved, after the query basis changes, or after
the Memory record is revised.

The TypeScript repository was inspected at commit
[`e94a183e4845f29dfe79aef91c787653a9cfa0f8`](https://github.com/Huasushis/Dolly/commit/e94a183e4845f29dfe79aef91c787653a9cfa0f8).
Its legacy [`extensions/memory/index.ts`](https://github.com/Huasushis/Dolly/blob/e94a183e4845f29dfe79aef91c787653a9cfa0f8/extensions/memory/index.ts)
stores recalled text in a mutable cache and concatenates it into
`getOutputPremise()`. Its five-second timer limits search attempts but cannot
explain whether a particular Memory record should appear again. The newer
[`src/extensions/memory/module-action.ts`](https://github.com/Huasushis/Dolly/blob/e94a183e4845f29dfe79aef91c787653a9cfa0f8/src/extensions/memory/module-action.ts)
correctly returns recall as an ordinary untrusted Block and excludes the source
Blocks in the current input batch. It still has no cross-request record of why
a previously presented record was selected or suppressed.

Premise has already been defined as a deterministic projection of a frozen
Module Descriptor. Putting recalled user data there would make runtime evidence
look like capability or policy, would hide its Block provenance, and would make
replay depend on a mutable cache.

## Decision

Recalled content crosses Module boundaries only in an ordinary Block. When an
LLM consumes selected records, the LLM Extension compiles each one into a typed
`memory_evidence` part in an `external` canonical message. It never places the
record in a Descriptor projection, system message, developer policy, tool
allowlist, or approval input.

Every search constructs an effective query basis. It contains the Block that
carries the search Action, every source Block in the frozen Activation input,
and any earlier committed Block explicitly declared as having contributed to
the query. A record whose provenance intersects that basis is filtered before
ranking. Memory-produced recall/control content is ineligible for ingestion,
so a recall Block cannot become a new Memory record and feed itself back.

Deduplication has two scopes:

1. Within one target model request, one `(memory_id, record_revision)` may be
   included at most once, even when duplicate Deliveries, two Pages, or two
   searches nominate it. This is a hard correctness rule.
2. Across different target model requests, the same record revision may be
   included again. There is no time-only per-record ban. Every include or
   suppress decision is bound to the exact target request and records the
   retrieval identity, query digest, prior model-request count, policy revision,
   and a closed reason.

The rate limiter for automatic retrieval controls attempts and resource use. It
does not make a Memory record ineligible and never changes explicit-search
results. Explicit search remains deterministic for a frozen query and index
snapshot and does not consult presentation history.

## Alternatives rejected

- Put recall in Premise: promotes untrusted evidence into a high-authority,
  mutable capability description and loses ordinary Block delivery semantics.
- Return recall sometimes as Premise and sometimes as Block: creates two
  provenance, replay, deletion, and trust contracts for the same content.
- Prohibit one record for a fixed day or cooldown: suppresses relevant evidence
  without considering the current task and makes local-time boundaries affect
  behavior.
- Never deduplicate: duplicate Page routes can consume context budget and bias
  the model by repeating the same evidence in one request.
- Use access count as proof of usefulness: presentation is not evidence that
  the model read, cited, or benefited from the record and creates a
  self-reinforcing ranking loop.

## Consequences and rollback

The stable implementation needs query-basis digests, typed Memory evidence in
canonical model requests, and a semantic validator for duplicate Memory result
identities. Automatic selection additionally needs immutable decision records
and a join to Model Gateway request audit. These records contain identifiers
and reasons, not recalled text.

Disabling automatic selection removes its decision policy and leaves explicit
search, ordinary recall Blocks, and typed external context intact. Rolling back
an experimental policy cannot reinterpret prior decisions or move recalled
content into Premise. `TST-MEM-001` and `TST-INJECT-001` cover the stable and
experimental boundaries.
