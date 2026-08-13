# Dolly, OpenClaw, and Hermes Comparison Specification

Status: **Experimental evaluation**. This track compares pinned systems; it is
not a stable product claim and does not import another framework's semantics.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for the comparison.

`REQ-COMPARE-001` — Every Dolly/OpenClaw/Hermes result MUST pin an exact
commit, tag, or build plus artifact and launch-config digests for each system;
floating branches, mutable images, and `latest` labels are invalid evidence.

`REQ-COMPARE-002` — Systems MUST use the same tasks, machine/environment,
model snapshots, browser/tools, permissions, data, retry policy, and resource
budgets unless the difference is the declared treatment and reported on a
quality-cost frontier.

`REQ-COMPARE-003` — The harness MUST classify each failure from independent
trace/state evidence as framework, model/provider, tool/browser, environment,
task/oracle, harness, or unresolved; model errors MUST NOT be silently charged
to a framework and framework failures MUST NOT be hidden as model variance.

`REQ-COMPARE-004` — Conclusions MUST report repeated-run success, reliability,
cost, latency, and failure classes by task family; Dolly's unique Page/Module
claim requires an equal-budget single-agent control and held-out long-term,
task-switching, and learning tasks.

## 1. System pins and adapters

The plan `track` is `framework_comparison`. Its `systems` MUST contain Dolly as
`candidate` and OpenClaw and Hermes as `external_baseline`, each with immutable
source revision, built artifact digest, launch configuration digest, model
profile digest, tool snapshot digest, and environment digest. A tag is
acceptable only when the fetched source/artifact is also content-addressed.
The comparison packet retains build commands, dependency lockfiles, patches,
and license/provenance metadata.

Adapters MAY translate task ingress and collect results, but MUST NOT add
planning, Memory, retries, tool calls, or privileged information. Adapter code
and configuration are pinned. Native system features remain enabled only when
they fit the declared treatment and common permission/budget envelope.

## 2. Comparison questions

The suite SHOULD use OpenClaw as an operations/Channel-oriented external
baseline and Hermes as a Memory/Skill/learning-oriented external baseline only
for capabilities actually present in the pinned revisions. Marketing claims or
current documentation do not substitute for observed, version-specific
behavior.

At minimum, include:

- simple control tasks where orchestration should not help;
- external Channel and restart/recovery tasks;
- state-verified tool and browser tasks;
- long-session Memory, fact correction, and task interruption/resumption;
- same-distribution and cross-domain learning tests; and
- Dolly Page/Module topologies paired with a competent single-agent Dolly arm.

Unsupported capability is reported as unsupported, not an automatic failure on
an unrelated claim. Task inclusion, exclusions, and per-system eligibility are
frozen before outcomes are viewed.

## 3. Fair execution

Runs use the same physical machine or reproducibly isolated equivalent, OS
image, locale/timezone, browser, network fixtures, tool servers, model/provider
snapshot, temperature, context/token limits, maximum calls, concurrency,
retries, wall time, monetary budget, and task order policy. Warmup, caching,
background services, and setup time are either equalized or measured.

When architectures cannot accept identical limits, the plan declares the
resource mismatch before execution and reports a quality-cost frontier. It
MUST NOT describe an arm with a stronger model, larger context, broader tools,
or more attempts as an architectural win at equal budget.

## 4. Oracle and failure attribution

Task success is determined by final environment state or exact evidence.
Framework health, provider transcript, tool trace, adapter events, resource
limits, and oracle events use a shared timestamp/trace correlation. Two blinded
reviewers or a deterministic classifier with adjudication rules assign the
failure class; unresolved disagreements remain `unresolved`.

The report separates setup failure, framework crash/deadlock/state loss,
invalid framework tool request, correct request with tool failure, provider
refusal/error, model reasoning error, environment drift, invalid task, oracle
failure, and harness failure. Harness/task/oracle failures do not become wins
or losses and remain visible in denominators according to the preregistration.

## 5. Metrics and conclusion

Required metrics are per-task and repeated-run success, pass@1 and configured
pass^k, tail reliability, task-state integrity, tokens, model/tool calls, cost,
wall time, setup/recovery time, framework crashes, tool errors, duplicate work,
context occupancy, Memory accuracy, task-switch recovery, and each failure
class. Report distributions and confidence intervals, not one demonstration.

A favorable comparison can justify continued Dolly development or a narrowly
scoped promotion packet; it cannot prove general superiority. In particular,
the Page/Module hypothesis is supported only if Dolly improves the
preregistered held-out objective over its equal-budget single-agent control and
the external baselines without violating non-inferiority or absolute gates.

