# Learning Experiment Specification

Status: **Experimental**. This specification defines evidence needed to claim
learning; it does not make Memory, Reflection, or procedural transfer stable.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for the experiment.

`REQ-LEARN-001` — A learning claim MUST bind an executable plan, immutable
pre-learning state, a named learning intervention, immutable post-learning
state, and paired run records under fixed model, tool, environment, and budget
controls.

`REQ-LEARN-002` — Evaluation MUST separately measure same-task retention,
same-distribution held-out generalization, cross-domain transfer, negative
transfer, and forgetting/update; repeating only the training task cannot
support a learning claim.

`REQ-LEARN-003` — The comparison MUST include no-learning, stable-Memory-only,
and intervention arms plus ablations that isolate retrieval, extra context,
policy/procedure creation, and extra model or tool calls.

`REQ-LEARN-004` — Promotion requires held-out benefit attributable to the
declared intervention, bounded negative transfer and forgetting, correct update
of superseded facts, unaffected-task non-inferiority, reproducibility, and
complete quality-cost reporting.

## 1. Units and states

The experimental unit is a grouped task/user/world family, not an individual
prompt when related prompts can leak a solution. Before intervention, the
harness snapshots all allowed Memory records, indexes, policies, Skills,
prompts, configuration, tools, environment, and model profiles. After the
training episode, it snapshots every changed or derived object and records the
intervention trace. Test runs start from a copy of one frozen post-intervention
state and MUST NOT learn from earlier test units unless sequential learning is
the declared treatment.

The plan `track` is `learning` and MUST contain `same-task-retention`,
`same-distribution-held-out`, `cross-domain-transfer`, `negative-transfer`, and
`forgetting-and-update`. Each unit declares which class it tests and has a
state/evidence oracle independent of the model response.

## 2. Required arms and leakage controls

At minimum compare:

1. frozen base system with no training episode;
2. stable Memory ingestion and explicit retrieval only;
3. the complete proposed learning intervention;
4. the intervention without each claimed learned artifact;
5. the complete intervention with the same extra token/call budget given to a
   non-learning control.

Train/development/held-out splits MUST group task generator, method family,
user/entity, conversation, temporal continuation, near duplicate, source
document, and answer-producing artifact. Held-out oracle explanations and
future updates are inaccessible during learning. Prompts, retrieval indexes,
few-shot examples, and caches are part of the leakage audit.

Repeated evaluation of the exact training task measures retention, not
generalization. Same-distribution held-out tasks must be unseen instances.
Cross-domain units preserve a method while changing surface domain and
vocabulary. Negative-transfer units make the learned method inapplicable.
Forgetting/update units replace an old fact or policy and require use of the new
revision plus correct treatment of time-scoped historical questions.

## 3. Run protocol

For each seed, execute paired baseline and intervention runs in randomized or
counterbalanced order against equivalent fresh environment snapshots. Record
model/provider snapshot, prompt and config digests, dataset/split revision,
seed, temperature, tool trace, retrieved and created artifact revisions, tokens,
cost, retries, and oracle evidence in the standard run record.

A crash, timeout, refusal, or budget overrun remains in the analysis. The
harness MUST verify that self-generated outputs were not recursively admitted
as independent training evidence unless that feedback loop is the declared
treatment. Cross-run caches and hidden provider state MUST be disabled or
reported as a limitation.

## 4. Metrics and decision

Primary metrics SHOULD be state-verified held-out success for the specific
learning claim. Required metrics are same-task retention, same-distribution
generalization, cross-domain transfer, negative-transfer error, correct
abstention, stale-fact use, update/forget correctness, unaffected-task success,
reliability distribution, tokens, calls, storage, latency, and cost.

Analysis MUST use the preregistered paired method and confidence intervals from
`method.md`. A gain explainable only by extra context, calls, tools, or leaked
test material is not learning. Evidence for one intervention promotes only
that intervention and artifact lifecycle; it does not establish autonomous
self-improvement or general intelligence.

