# Research Method Specification

Status: **normative for Dolly experiments**. An experiment result is not a stable product guarantee.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-RES-001` — Every result used to accept, reject, compare, or promote a
Dolly research feature MUST satisfy all normative preregistration, split,
randomness, repetition, metric, cost, reproducibility, adversarial, and
reporting controls in this chapter.

`REQ-RES-002` — Before execution, a promotion-relevant experiment plan MUST
conform to `schemas/research-experiment-plan.schema.json`, contain only pinned
system revisions, and be canonicalized and hashed; every run MUST conform to
`schemas/research-run-record.schema.json` and bind that immutable plan digest.

## 1. Separation from production semantics

Research code MUST run behind an explicit experiment identity and MUST NOT be required for Core correctness. The stable implementation MUST remain available as a control and fallback. An experiment MUST NOT change Block immutability, Activation commit, Page cursor, Asset retention, capability, secret, audit, or side-effect semantics.

Offline experiments SHOULD use immutable snapshots. Online experiments MUST use the promotion stages in `promotion-gates.md` and MUST have an immediate kill switch.

## 2. Preregistered experiment plan

Before viewing held-out outcomes, each experiment MUST commit an immutable plan containing:

- experiment ID, owner, date, code and configuration revisions;
- falsifiable hypothesis and intended product decision;
- experimental unit and unit of randomization;
- treatment factors and all tested values;
- stable baseline and any external baseline;
- datasets, versions, eligibility, exclusions, and train/development/held-out split;
- model/provider snapshots, prompts, tools, environment snapshot, and permissions;
- random seeds and number of repetitions per unit;
- one or more primary metrics, direction, aggregation, and statistical test;
- secondary, diagnostic, safety, reliability, latency, token, and monetary-cost metrics;
- minimum effect or equivalence/non-inferiority margins;
- sample-size or power rationale;
- missing-run, retry, timeout, and outlier policy;
- maximum calls, tokens, cost, wall time, and stopping rule;
- leakage controls and a signed hash of the plan.

Changing a primary metric, margin, exclusion, or analysis after outcomes are inspected creates a new experiment ID. Exploratory post-hoc analysis MUST be labeled exploratory and MUST NOT satisfy a promotion gate by itself.

### 2.1 Executable plan and run contract

The machine plan schema is
[`research-experiment-plan.schema.json`](../../../schemas/research-experiment-plan.schema.json).
The harness MUST reject a plan before any run when it contains a floating
revision such as `latest`, omits train/development/held-out manifests, lacks at
least two treatments or seeds, omits a primary/non-inferiority/safety metric,
or fails a track-specific required-case gate. Registration returns the SHA-256
digest of RFC 8785 canonical plan bytes. Registration MUST NOT fetch or resolve
a floating dependency after producing that digest.

For each unit, treatment, repetition, and seed, the harness emits one
[`research-run-record.schema.json`](../../../schemas/research-run-record.schema.json)
record. The tuple `(plan_digest, unit_id, treatment_id, repetition, seed)` MUST
be unique. A timeout, refusal, crash, budget exhaustion, or invalid output is a
recorded run outcome, never a silently discarded sample. Metric aggregation
MUST consume only records bound to the registered plan and MUST fail closed on
duplicate tuples, mismatched system artifacts, unrecognized metrics, or a
missing trace digest.

The minimum runner interface is:

```text
register(canonical_plan) -> plan_digest
execute(plan_digest, unit_id, treatment_id, repetition, seed) -> run_record
score(plan_digest, immutable_run_records) -> analysis_artifact
decide(plan_digest, analysis_artifact) -> governed conclusion
```

`execute` MUST start from the split's frozen environment snapshot. `score` and
`decide` MUST be deterministic for the same records and analysis-code digest.

## 3. Data splits and leakage

Training or tuning may use only the training split. Thresholds, prompt selection, hyperparameters, and early stopping may use the development split. The held-out split MUST remain unread by the optimization loop until the candidate and analysis code are frozen.

Near duplicates, shared conversations, derived variants, users, entities, and temporal continuations MUST be grouped before splitting when they could leak the answer. Retrieval indexes and Memory state for a split MUST be constructed only from data allowed by that split.

Public benchmark contamination risk MUST be documented. Dolly-specific tests SHOULD include secret canaries or newly generated instances. A benchmark score without a reproducible environment and final-state verifier MUST be treated as diagnostic, not dispositive.

## 4. Randomness, repetitions, and comparison

Every stochastic component MUST record its seed or explicitly state that the provider does not expose deterministic seeding. Dataset order, simulated time, topology initialization, and local random policies MUST be seeded independently.

Treatments SHOULD use paired instances: the same task, environment snapshot, tool state, and permitted budget under baseline and treatment. Execution order SHOULD be randomized or counterbalanced. Provider throttling and time-of-day effects SHOULD be blocked or recorded.

One model run is never sufficient evidence for a stochastic agent. The preregistration MUST specify repeated trials and report the complete outcome distribution, including median and relevant quantiles, success probability, and failure modes. Failed and timed-out runs count according to the preregistered policy and MUST NOT be silently rerun until successful.

## 5. Metrics and statistical reporting

Primary success SHOULD be verified from task state or exact evidence, not an LLM's self-report. LLM judges MAY be secondary metrics only when judge model/revision, rubric, position randomization, calibration set, and human agreement are recorded.

For each primary comparison, the report MUST provide sample size, point estimate, uncertainty interval, raw paired differences when available, and the preregistered test. Multiple primary comparisons MUST use a preregistered correction or hierarchical decision rule.

Non-inferiority is established only when the relevant one-sided confidence bound excludes degradation beyond the preregistered margin. Absence of a statistically significant difference is not evidence of equivalence. Safety and Core-invariant failures use absolute gates and cannot be averaged away by task success.

## 6. Cost and resource accounting

Every run MUST record input, output, reasoning, cached, image/audio, and tool units when available; provider-reported or estimated provenance; currency and pricing revision; wall time; queue time; retries; tool calls; network bytes; peak memory; and persistent-storage growth.

Comparisons MUST report both quality and cost. A treatment that receives a larger model, context, request count, tool permission, retry budget, or wall-time limit is not a controlled architectural comparison unless that resource is the declared treatment factor.

Runs that exceed the preregistered budget MUST terminate safely and remain in the dataset as budget failures.

## 7. Reproducibility artifacts

Each completed experiment MUST retain:

```text
plan
dataset manifest and hashes
split manifest
code/config/prompt/model revisions
environment and tool snapshot
seed manifest
raw run records and traces
metric implementation and tests
analysis output
failure taxonomy
cost report
decision and ADR link
```

Sensitive payloads MAY be access-controlled or irreversibly redacted, but hashes, eligibility, and aggregate counts MUST remain sufficient to audit the decision. An analysis notebook without a scriptable, deterministic metric path is insufficient.

## 8. Adversarial and fault evaluation

Every candidate that processes untrusted data MUST include malformed, oversized, ambiguous, prompt-injected, conflicting, unauthorized, and missing-data cases. Stateful candidates MUST include restart, duplicate delivery, stale revision, clock jump, storage failure, and partial external-outcome cases.

The experiment MUST test abstention and negative cases, not only examples where the feature should activate. It MUST measure collateral behavior on unaffected workloads.

## 9. Reporting conclusion

The report MUST end with one of: reject, inconclusive, continue research, enter shadow, advance promotion stage, or revert. It MUST name the exact evidence and limitations. Qualitative anecdotes MAY explain failures but MUST NOT override the preregistered primary decision rule.
