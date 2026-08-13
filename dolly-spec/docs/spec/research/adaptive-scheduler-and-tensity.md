# Adaptive Scheduler and Tensity Research Specification

Status: **Experimental**. Dolly v1 stable scheduling remains deterministic event-driven scheduling with configured coalescing, latency bounds, and backpressure.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative for the experiment and its safety boundary.

`REQ-SCHED-001` — Any adaptive-scheduler experiment MUST satisfy every
normative clamp, fallback, workload, fairness, recovery, measurement, and
promotion obligation in this chapter while leaving the Core scheduler
authoritative.

`REQ-TENSITY-001` — Any `tensity` experiment MUST satisfy every normative
semantic, range, adversarial, fixed-budget, ablation, fallback, and promotion
obligation in this chapter; `tensity` is never authority for durability,
deletion, permission, or side-effect retry.

`REQ-TENSITY-002` — A `tensity` producer and consumer MUST use the Core opaque
research-hint envelope and a schema-valid enabled research-hint registration
that pins one qualified name, version, payload schema URI and digest, experiment
and plan digests, producer/consumer Modules, and graph/config revision; Dolly v1
defines no stable range or default.

## 1. Stable safety envelope

An experimental controller MAY recommend the next eligible Activation time, coalescing interval, batch limit, or context-selection hint. The Core scheduler remains authoritative and MUST clamp every recommendation to configured minimum interval, maximum latency, batch/byte limits, concurrency, quota, and deadline.

No controller may advance a Page cursor, cancel a committed delivery, run the same Module concurrently, bypass a capability, alter a Block/Asset lifetime, or directly change another Module's configuration. Disabling the experiment MUST immediately restore the stable scheduler without migration.

Per-subscriber backpressure and durable Page buffering remain stable mechanisms. An experiment MUST NOT slow an entire upstream Module merely because one unrelated subscriber is slow.

## 2. Candidate controllers

Research MAY compare static event/debounce scheduling with AIMD, PI/PID, queueing-based, learned, or hybrid policies. Each controller MUST declare:

- observed inputs and their units;
- state variables and initialization;
- update equation and update cadence;
- clamps, anti-windup, hysteresis, and cooldown;
- behavior on missing/stale metrics and restart;
- deterministic seed when stochastic;
- maximum rate of parameter change;
- fallback trigger.

Controller state MUST be versioned and discardable. Restart MUST use a preregistered cold-start rule, not reconstruct hidden state from future observations.

## 3. Tensity semantics

`tensity` is an untrusted research hint about context-selection priority or desired cognitive attention. It MUST be carried under a preregistered qualified key such as `org.dolly.research.tensity`, using the opaque envelope in [Block and Action](../core/02-block-and-action.md) and the machine [research-hint registration](../../../schemas/research-hint-registration.schema.json). The plan MUST freeze the envelope version, payload schema URI and digest, payload units and allowed values, calibration, producer, consumer, eligible Modules, and graph/config revision. A consumer MUST validate the payload against the pinned schema before use. Producer and consumer Module IDs MUST appear in the matching registration. A mismatched, non-finite, out-of-plan, missing, expired, or invalid value selects the stable behavior as if no hint existed.

The stable specification intentionally defines no numeric range, neutral value,
or conversion across experiments. A value from one experiment MUST NOT be
compared with or converted to another version unless that conversion is itself
preregistered and tested. Experiments MUST separately compare Module-produced,
Runtime-calculated, and hybrid producers when producer choice is part of the
hypothesis; a producer MUST NOT gain additional data authority merely by being
registered.

Tensity MUST NOT control:

- Block, Page, Asset, Memory, configuration, or tool-transaction deletion;
- reference counts, leases, or pins;
- whether committed input is acknowledged;
- permissions, cost limits, or retry of side effects;
- irreversible forgetting or prompt/identity rewriting.

The first tensity experiment MAY affect only an LLM context candidate score inside an otherwise fixed token budget. It MUST retain Runtime contract, current input, unresolved tool transactions, and pinned evidence regardless of hint. Random eviction is a separate treatment from deterministic weighted ranking and MUST use recorded seeds.

## 4. Workloads and experimental design

Scheduler evaluation MUST include bursty ingress, steady load, mixed fast/slow Modules, multiple subscribers with one slow branch, cycles, provider rate limits, CPU-bound Extensions, crash/restart, disk backpressure, and idle periods. Workload arrival traces and service-time distributions MUST be fixed or seeded and held out from controller tuning.

At minimum compare:

1. stable fixed debounce/latency configuration;
2. manually tuned static configurations at equal resources;
3. each adaptive controller;
4. controller with feedback inputs individually ablated;
5. controller under delayed/noisy/missing feedback.

Tensity evaluation MUST use tasks where important old evidence competes with plausible distractors, plus negative cases where hint values are adversarial, uniformly high, uniformly low, missing, or correlated with verbosity rather than usefulness.

The stable no-hint path is the control. Every experiment MUST include a payload
schema mismatch, unknown version, unknown qualified key, disabled registry
entry, stale graph/config revision, and unauthorized producer. In all six cases
the consumer MUST ignore the payload, record the reason, and preserve stable
output and Core invariants.

## 5. Metrics

Required scheduler metrics are task success, end-to-end p50/p90/p99 latency, deadline miss rate, subscriber lag, queue bytes, throughput, Activation count, batch size, wasted/duplicate work, oscillation, fairness across subscribers, crash recovery, CPU, memory, tokens, provider requests, and cost.

Required tensity metrics are downstream task quality, evidence recall/precision, critical-context eviction count, token use, variance across seeds, false prioritization, and calibration between hint bucket and measured utility.

Oscillation MUST be reported from the controller output and backlog time series, not inferred from averages. Tail latency and worst subscriber starvation MUST have explicit gates.

## 6. Shadow and canary behavior

In shadow, the controller observes copied metrics and records recommendations, but the stable scheduler acts. The evaluation MUST compute counterfactual actions without pretending unexecuted downstream results are known.

In canary, the Core MUST enforce hard clamps and a stable fallback. Automatic fallback MUST trigger on invariant violation, controller error/staleness, queue or tail-latency threshold, starvation, cost ceiling, or oscillation detector. Fallback and controller state MUST be journaled.

Adaptive state MUST not be shared across canary and control Modules unless that sharing is the declared treatment. An online experiment MUST not alter topology or model profile simultaneously.

## 7. Promotion constraint

A controller may advance only if held-out results improve the preregistered primary objective while meeting non-inferiority for success, tail latency, fairness, cost, and every Core invariant. A tensity policy must additionally beat recency/relevance baselines, remain safe under adversarial hints, and show benefit beyond extra randomness or context budget.

Promotion of a controller does not promote tensity, and promotion of a context policy does not authorize lifecycle use. Each semantic expansion requires a separate experiment and gate.
