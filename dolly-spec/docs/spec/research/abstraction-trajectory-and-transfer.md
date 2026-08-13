# Abstraction, Trajectory, and Method-Transfer Research Specification

Status: **Experimental**. Stable Memory retrieval remains lexical/dense search
with provenance. This track does not make an abstract pattern a fact, Skill,
Reflection Policy, or Core relation.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for the experiment and its safety boundary.

`REQ-XFER-001` — A method-transfer experiment MUST use a registered executable
plan and immutable run records, preserve source evidence, and keep all derived
patterns removable from the stable Memory baseline.

`REQ-XFER-002` — The comparison MUST include a competent lexical/dense control,
surface-normalization controls, syntactic/semantic-role representations,
sequence/trajectory candidates, and an evidence-bound LLM-abstraction arm at
equal retrieval and model budgets.

`REQ-XFER-003` — Held-out evaluation MUST include lexically disjoint
cross-domain transfer, wrong analogies, missing preconditions that require
abstention, and method families unseen during tuning.

`REQ-XFER-004` — Promotion requires held-out transfer benefit beyond the best
stable control while meeting preregistered negative-transfer, evidence,
abstention, cost, latency, and unaffected-task non-inferiority gates.

## 1. Question and semantic boundary

This track asks whether Dolly can retrieve and apply a reusable method when the
new task uses different entities, nouns, adjectives, or surface vocabulary.
Similarity of embeddings or trajectories is only a candidate signal. It MUST
NOT be represented as proof that two tasks have the same preconditions,
operation, result, or causal structure.

Every derived pattern MUST name its algorithm/model revision, input evidence,
extracted preconditions, output claim, confidence, and experiment ID. A result
shown to a model MUST link back to the original visible evidence. Disabling the
track MUST restore stable retrieval without rewriting Memory records.

## 2. Required treatment arms

At minimum, the plan MUST compare:

1. lexical+dense retrieval with no abstraction;
2. entity/noun masking and noun+adjective masking;
3. dependency or semantic-role templates such as actor–operation–object and
   condition–operation–result;
4. sequence-shape candidates, including one simple alignment baseline such as
   dynamic time warping and one learned sequence representation;
5. an LLM-produced method template with explicit applicability conditions and
   immutable source evidence.

Each learned arm MUST have an ablation without its claimed invariant. A
geographic-trajectory method such as T2Vec MAY be evaluated only as a named
candidate; the experiment MUST NOT assume that geographic and semantic
trajectories share the same invariances. Additional model calls or returned
tokens count against the common budget.

## 3. Executable corpus and split

The plan `track` is `abstraction_transfer` and MUST include the schema-required
cases `lexical-disjoint-transfer`, `missing-precondition-abstention`,
`wrong-analogy`, and `held-out-cross-domain`. A benchmark unit contains:

```text
source task and evidence
source method steps and necessary preconditions
target task and environment snapshot
expected applicable / inapplicable label
state or evidence oracle
method-family and generation-family group IDs
```

Splits MUST group method family, source template, generator, near duplicate,
and any shared answer-producing artifact. The held-out split MUST contain both
unseen surface domains for known method families and entirely held-out method
families. Tuning MUST NOT inspect held-out retrieval candidates, outcomes, or
oracle explanations.

For each run, the harness freezes top-k, token budget, allowed evidence, model
profile, tools, prompt, and environment. It records the ranked candidates,
pattern revision, cited source units, extracted preconditions, abstention, final
action or answer, and exact oracle evidence in the standard run record trace.

## 4. Negative transfer and adversarial cases

The suite MUST contain superficially similar tasks with one missing critical
precondition, reversed causal direction, incompatible tool/API semantics,
conflicting evidence, malicious instructions inside retrieved material, and a
high-scoring but wrong analogy. The correct result for these cases is
abstention or use of the stable path.

Pattern text is untrusted content. It MUST NOT grant tools, rewrite trusted
policy, hide provenance, or become a persistent Skill/Reflection merely because
it was retrieved. Authorization filtering applies before candidate generation
and again before evidence disclosure.

## 5. Metrics, analysis, and gate

Primary metrics SHOULD be state-verified transfer success and correct
abstention on the predefined transfer-eligible population. Required diagnostics
are Recall@k/Precision@k, evidence precision, precondition recall, wrong-analogy
rate, negative-transfer rate, calibration, tokens, calls, latency, and cost.
Results MUST be reported by known-family/unseen-surface and unseen-family
strata; an aggregate MUST NOT hide failure on the latter.

The treatment must beat lexical+dense and normalization controls at the fixed
budget. Any statistically or operationally material increase in wrong transfer,
unsupported claims, permission attempts, or ordinary-query regression blocks
promotion. Passing this track permits only the evaluated retrieval capability;
automatic procedural-memory or policy creation requires its own track and gate.

