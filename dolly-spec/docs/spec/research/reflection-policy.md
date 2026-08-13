# Reflection Policy and Long-Term Thinking Research Specification

Status: **Experimental**. Stable Dolly has no self-modifying long-term prompt.
Candidate policies are isolated derived state and are disabled by default.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for the experiment and its safety boundary.

`REQ-REFLECT-001` — A Reflection candidate MUST be a bounded, versioned record
with rule, scope, evidence, confidence, status, priority, provenance, creation
time, and optional expiry; a free-growing identity string is not conformant.

`REQ-REFLECT-002` — Candidate generation, evidence review, historical shadow
replay, held-out regression, activation, expiry, revocation, and rollback MUST
be explicit auditable transitions, never an in-place prompt rewrite.

`REQ-REFLECT-003` — Evaluation MUST separate retention of prior feedback from
same-distribution generalization and cross-domain behavior, and MUST include
unsupported, conflicting, stale, adversarial, and harmful-rule cases.

`REQ-REFLECT-004` — No policy may influence a stable prompt until it passes the
general research gates plus held-out benefit, unaffected-task non-inferiority,
evidence precision, identity-safety, expiration, and rollback gates.

## 1. Candidate representation

A conforming candidate contains at least:

```text
reflection_id and revision
behavioral rule and explicit scope
supporting and contradicting Block/Memory evidence
generator/prompt/model/config revisions
confidence and priority
candidate | shadow | active-canary | revoked | expired status
created_at, reviewed_at, and optional expires_at
experiment and decision-record IDs
```

Rules SHOULD use direct behavioral instructions or subjectless constraints, for
example “before judging API compatibility, inspect actual fields and errors.”
First-person identity claims are a separate treatment because they can create
unsupported self-narrative. Style cannot substitute for evidence.

The store MUST be bounded by count and bytes. Conflicting rules MUST remain
separate evidence-bearing candidates until a declared resolver handles them;
the system MUST NOT concatenate them into an ever-growing string. Deletion of
derived candidates MUST NOT delete source evidence.

## 2. Generation and state transitions

Only training/development evidence may generate or tune a candidate. The
generator MUST cite repeated failure or feedback examples and search for
contradicting evidence. A candidate with missing, inaccessible, circular
self-output, or fabricated evidence is rejected.

The required path is:

```text
generate candidate -> validate evidence -> historical shadow replay
-> held-out regression -> governed canary -> active-canary
-> expire, revoke, or separately promote
```

Shadow replay compiles the candidate into the same prompt position and token
budget proposed for use, but suppresses external side effects. Activation MUST
pin the exact candidate revision, compiler revision, position, scope, and graph
configuration. A kill switch MUST exclude all candidate text without requiring
the Memory or reflection component to be healthy.

## 3. Executable experiment

The plan `track` is `reflection_policy` and MUST include
`unsupported-candidate`, `historical-shadow-replay`, `held-out-regression`, and
`expiry-or-revocation`. Required arms are stable prompt only, stable prompt plus
raw retrieved feedback at equal tokens, structured candidate in shadow, and
each tested wording/person treatment. A summarizer-only arm does not establish
behavioral learning.

Splits MUST group user, conversation, task family, feedback source, generated
variants, and temporal continuation. Held-out units cannot contribute evidence
to the candidate. Each run records the compiled prompt digest, included policy
IDs/revisions, cited evidence, scope decision, token placement, task result,
policy compliance, and all policy-attributable failures.

The suite MUST test a valid rule outside its scope, a once-valid expired rule,
a rule contradicted by newer evidence, hostile instructions in evidence, a
rule that attempts capability escalation, two incompatible candidates, and
rollback during a running session. Disabled/revoked/expired candidates MUST be
absent from newly compiled prompts and MUST NOT influence stable retrieval.

## 4. Metrics and promotion

Required metrics are held-out task success, recurrence of the targeted failure,
correct scope/abstention, unsupported-rule rate, contradiction handling,
identity-claim rate, unaffected-task regression, prompt tokens, latency, cost,
expiry latency, and rollback completeness. Evidence precision and any
capability or policy violation are absolute gates.

Improving historical replay alone does not prove learning; the candidate MUST
also improve the preregistered held-out objective. Promotion applies only to the
evaluated generation, representation, compiler, placement, and scope policy.
It does not authorize automatic Skill creation, unrestricted premise rewriting,
or permanent identity claims.

