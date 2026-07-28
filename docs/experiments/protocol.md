# Dolly Experiment Protocol

Status: Draft

This is a forward-looking protocol, not evidence that any historical script or
report satisfies it. The retained materials in `test/experiments/` and
`test/memory-experiments/` are classified separately in
`docs/takeover/historical-experiment-materials.md`.

Preregistered subsystem experiments that apply these rules include:

- `linux-core-service-process-ownership.md`, which defines the failure and
  recovery matrix required before the Proposed Linux Core service ownership of
  Module processes can be promoted through its Architecture Decision Record
  (ADR).

This document defines the minimum evidence required before an experimental
mechanism may influence Dolly's product architecture. It applies to scheduling,
multi-agent organization, memory, prompting, tool use, multimodal processing,
and provider-specific behavior.

## Principles

- An experiment MUST state a falsifiable hypothesis before collecting results.
- Product code, private deployments, and paid services MUST NOT be prerequisites
  for reproducing the default experiment path.
- A mechanism MUST be compared with the simplest relevant baseline. A result
  without a baseline is descriptive, not evidence of improvement.
- Tuning data and evaluation data MUST be separated. Evaluation examples MUST
  NOT influence prompts, thresholds, scoring rules, or parameter selection.
- A failed run MUST exit non-zero and remain a failed run. It MUST NOT silently
  fall back from a live backend to a mock backend.
- Raw events and errors MUST be retained so aggregate claims are auditable.

## Experiment manifest

Every run MUST produce a machine-readable manifest containing:

- experiment and protocol version;
- source commit and dirty-worktree indicator;
- complete redacted configuration and prompt versions;
- dataset name, version, split, and content hash;
- model endpoint capability profile and exact model identifier;
- backend kind (`fake`, `local`, or `live`), with no silent substitution;
- random seeds and execution order;
- per-case token, call, latency, retry, and error counts;
- raw task outputs, deterministic validator results, and aggregate metrics.

Secrets, private endpoint URLs, and private media URLs MUST NOT be stored in an
artifact. Private identifiers MUST be replaced with stable redacted labels.

## Gates

### Gate 0: contract and safety

Exploratory work MAY run in an isolated deterministic harness before product
conformance exists when its purpose is to resolve a Draft decision. Before such
work begins it MUST state the hypothesis, baseline, stopping rule, affected
contract question, and threat/data boundary. It MUST NOT use live credentials,
private user data, paid calls, or a known P0 exploit path.

Known P0 security defects, unhandled process errors, reference leaks, undeclared
message loss, or cross-session contamination block experiments through the real
Dolly runtime. They do not block a bounded standalone simulator that cannot
reach those paths and is clearly labeled exploratory.

### Gate 1: deterministic contract tests

Provider behavior MUST first be exercised through deterministic fake servers.
Tests MUST assert exact normalized requests, streaming reconstruction, tool-call
state transitions, retries, cancellation, and failure classification.

Gate 1 is where a subsystem earns contract conformance; Gate 0 does not require
that result in advance. Gates 2 through 5 require all relevant Gate 1 tests to
pass unless the run is explicitly an exploratory component study that makes no
product or architecture claim.

### Gate 2: component evaluation

The component MUST use at least one simple baseline. Data-driven or tuned
mechanisms MUST use fixed train/development/test splits; deterministic mechanisms
with no fitting MAY use a fixed calibration/evaluation split and explain why no
training split exists. Metrics and a minimum practically relevant effect MUST be
declared before reading evaluation results.

For retrieval and memory, the default report includes Recall@k, MRR or NDCG,
answer correctness, false-memory use, p50/p95 latency, token cost, and storage
growth. Recommended baselines are no-memory, lexical retrieval, vector retrieval,
and a justified hybrid.

### Gate 3: Dolly integration and fault tests

The experiment MUST run through the real Dolly runtime, not a parallel ad-hoc
orchestrator. It MUST cover state isolation, cancellation, timeouts, process
restart, malformed responses, duplicate deliveries, and backend unavailability.

### Gate 4: controlled live canary

Every live call requires an explicit `RUN_LIVE_INTEGRATION=1` opt-in plus
configured maximum calls and elapsed time. A fixture that may incur charges also
requires `RUN_PAID_INTEGRATION=1` and a finite spend budget. A live failure MUST
NOT fall back to fake data. Private owner infrastructure is one optional fixture
and MUST NOT be the only supported fixture.

### Gate 5: comparative claim

Architecture comparisons MUST use equal model, tool, token, time, and information
budgets wherever those variables are not the subject of the hypothesis. Cases
SHOULD use randomized paired order and isolated state. Reports MUST show per-case
deltas and uncertainty, normally paired bootstrap 95% confidence intervals.

A mechanism advances only if it meets its predefined minimum effect without
regressing safety, error rate, p95 latency, or cost beyond declared limits. A
single promising run is a reason to iterate, not a completion criterion.

## Validators

- Prefer deterministic task-state validators over keyword matching or model
  self-report.
- If semantic judging is unavoidable, use a versioned rubric, blinded condition
  labels, repeated judging, and a human-audited sample.
- Receiving any response is availability, not task success.
- Ground truth MUST be independent of the feature being evaluated.

## Promotion

Experimental mechanisms remain behind an explicit feature flag or scheduler/
extension strategy interface. Promotion to a default requires an accepted ADR
that links the preregistered hypothesis, raw artifacts, analysis, known failure
modes, conformance changes, and rollback plan.
