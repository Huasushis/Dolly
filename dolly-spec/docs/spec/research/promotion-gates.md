# Research Feature Promotion Gates

Status: **normative governance for all Dolly research features**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-PROMO-001` — No research feature may enter a later lifecycle state unless
it satisfies every normative evidence, absolute gate, fallback, rollback,
compatibility, soak, and decision-record obligation in this chapter.

## 1. State machine

Every research feature has exactly one lifecycle state:

```text
RESEARCH -> SHADOW -> FLAGGED_CANARY -> STABLE_CANDIDATE -> STABLE
    ^          |             |                 |
    +----------+-------------+-----------------+
                         REJECTED
```

Forward transitions MUST occur one stage at a time through an approved decision record. Any active stage MAY roll back to an earlier state or `REJECTED`. A feature MUST NOT silently become stable because code is merged, shipped, or enabled for one instance.

The lifecycle record MUST name feature ID, semantic scope, owner, code/config/schema revisions, experiment evidence, current default, eligible instances, kill switch, rollback procedure, and approval history.

## 2. Absolute gates at every stage

No feature may advance with an unresolved violation of Block immutability, Activation atomicity, single-flight Module execution, cursor monotonicity, capability/secret isolation, Asset reference safety, audit requirements, or side-effect unknown-outcome handling.

Security-critical findings, unauthorized data disclosure, irreversible migration without tested restore, or inability to disable the feature are blocking regardless of mean task quality. These are zero-tolerance gates, not non-inferiority metrics.

Every stage MUST preserve a tested stable fallback and MUST fit within configured calls, tokens, money, latency, memory, disk, and network limits.

## 3. RESEARCH

Research is offline or isolated. Entry requires an owner, hypothesis, threat model, and no dependency from stable correctness paths.

Exit to Shadow requires:

- a preregistered plan compliant with `method.md`;
- a working stable baseline and at least one meaningful ablation;
- unit, property, adversarial, and fault tests for the candidate boundary;
- held-out evidence that justifies observation on production-like inputs;
- measured resource/cost envelope;
- schema/version and data-deletion plan;
- kill switch and rollback proof.

Research output MUST NOT reach production Pages, prompts, schedules, tools, or external side effects.

## 4. SHADOW

Shadow receives a copy of eligible inputs and state references under the same authorization but MUST suppress all semantic outputs and external side effects. It MAY write isolated research records and telemetry with quotas. Shadow failure MUST not backpressure stable execution beyond a configured negligible limit.

Exit to Flagged Canary requires:

- shadow coverage across the preregistered workload and failure cases;
- agreement/counterfactual analysis against the stable path;
- no absolute-gate failure or unauthorized access;
- quality, latency, resource, and cost estimates within preregistered bounds;
- validated canary cohort selection and stop thresholds;
- proof that disabling and deleting shadow state does not affect stable state.

Shadow results MUST NOT claim actual downstream success when the candidate action was not executed; such outcomes are counterfactual or proxy metrics.

## 5. FLAGGED_CANARY

Canary execution requires an explicit feature flag and a small, identifiable cohort. The stable path MUST remain available per unit. Assignment MUST be sticky where state carryover matters and randomized or otherwise justified.

The system MUST automatically stop or fall back on any absolute-gate event, safety threshold, error-rate threshold, latency/backlog threshold, cost ceiling, data-integrity mismatch, or kill-switch activation. Stop events MUST be journaled.

Exit to Stable Candidate requires:

- completed preregistered sample and held-out analysis;
- primary benefit or justified operational benefit;
- non-inferiority for required unaffected outcomes;
- acceptable tail latency, reliability, and full quality-cost accounting;
- no unresolved canary-specific severe incident;
- successful rollback during canary and restart/fault drills;
- operator documentation and observability dashboard.

## 6. STABLE_CANDIDATE

A Stable Candidate has frozen user-visible semantics but remains opt-in or limited-default while implementation and operations mature. It MUST have a normative specification, versioned schemas, migrations, compatibility policy, conformance suite, security review, support runbook, backup/restore behavior, and ADR linking evidence to the decision.

The candidate MUST complete a preregistered soak period across supported platforms and representative load. No new algorithmic tuning may occur during the final soak; a material change restarts the relevant evidence window.

Exit to Stable requires all supported-platform tests, upgrade/downgrade or restore tests, cost-capacity review, documentation, telemetry/redaction review, and an approved default policy. Experimental state MUST be either migrated reversibly or rebuildable from stable sources.

## 7. STABLE

Stable means the documented behavior is supported and may be enabled by default. It does not mean immutable forever. Changes to normative semantics require compatibility review and, when they introduce a new unvalidated mechanism, a new feature lifecycle.

A stable feature MUST retain monitoring, bounded resources, rollback for the supported release window, and a path to rebuild derived state. Evidence and ADRs MUST remain linked from the specification.

## 8. Statistical decision rule

Each promotion plan MUST designate primary benefit metrics and required non-inferiority metrics with margins and direction. For a higher-is-better non-inferiority metric, the lower one-sided confidence bound of `(candidate - baseline)` MUST be greater than `-margin`. For lower-is-better metrics, the upper bound MUST be less than `margin`. The confidence level and multiplicity correction MUST be preregistered and normally be at least 95% family-wise for primary decisions.

A promotion that claims improvement MUST additionally meet its preregistered improvement threshold; non-inferiority alone does not prove benefit. An inconclusive interval blocks advancement unless the decision was explicitly an operational equivalence decision and all other gates pass.

Paired bootstrap or another preregistered paired method SHOULD be used for paired stochastic tasks. Reliability MUST report repeated-run success distribution. Cost MUST include model, tool, compute, storage, and operator-relevant overhead.

## 9. Rollback and data handling

Every online stage MUST define who or what can trigger rollback, maximum detection and disable time, treatment of in-flight work, state compatibility, derived-state deletion, and user-visible consequence. Rollback MUST NOT require the experimental component to be healthy.

If candidate state can influence future stable behavior, it MUST be namespaced and ignored after disablement until explicitly reviewed. Irreversible external side effects cannot be “rolled back” by a feature flag and therefore require the stable action/idempotency/unknown-outcome contract from the first canary.

## 10. Decision record

Every transition MUST publish a decision record containing plan hash, datasets and splits, seeds, raw-run location, metric code revision, complete results and uncertainty, safety/fault results, cost, incidents, deviations, limitations, approvers, stage, cohort/default, and rollback test result.

Missing evidence yields `INCONCLUSIVE`, not an implicit pass. Qualitative preference, a successful demo, or one favorable model run cannot satisfy a gate.
