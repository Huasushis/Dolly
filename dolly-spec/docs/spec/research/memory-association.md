# Memory Association Research Specification

Status: **Experimental**. Stable Memory MUST work with this subsystem absent or disabled.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative for the experiment and its safety boundary.

`REQ-ASSOC-001` — Any Memory-association experiment or promoted capability
MUST satisfy every normative representation, multi-scale proximity,
frequency-control, provenance, authorization, benchmark, ablation, and
promotion obligation in this chapter and MUST preserve the non-causal label.

## 1. Intended effect and semantic limit

This research tests whether repeated proximity can retrieve useful related memories that are not semantically similar. Every learned edge represents **association only**. The system MUST label it `temporal_cooccurrence_association` or another non-causal association type and MUST NOT infer that either endpoint caused, implied, answered, or is equivalent to the other.

Association expansion MUST preserve source evidence and MUST be removable without changing baseline Memory records.

## 2. Multi-granularity representation

The experiment MUST retain immutable source Blocks and stable Memory Units. Derived nodes MAY be:

- entity;
- concept;
- episode;
- procedure candidate;
- topic/community.

Membership MUST be many-to-many and versioned; one Memory Unit may belong to several overlapping nodes. The experiment MUST NOT force all material into one mutually exclusive flat clustering. Each node MUST record derivation algorithm/model, revision, confidence, source units, and creation time.

Comparisons MUST include at least source-unit-only, single flat clustering, and multi-granularity overlapping variants. Cluster granularity and thresholds are treatment factors, not hidden tuning knobs.

## 3. Proximity and time scales

Candidate pairs MUST be measured at multiple preregistered scales. At minimum, experiments SHOULD include event distance, short elapsed time, session, and cross-session/day scales. A generic proximity kernel is:

```text
K(i,j) = sum_s alpha_s * exp(-abs(delta_time)/tau_s)
         + beta * exp(-abs(delta_event_index)/nu)
```

The exact `alpha`, `tau`, `beta`, session-boundary decay, maximum pair distance, and event-time policy MUST be preregistered and versioned. No implementation may silently collapse all meanings of “near” into one fixed number of minutes.

Events with unknown or unreliable event time MUST use ingestion order only and MUST be labeled accordingly. Future timestamps, duplicates, and clock jumps MUST not create unbounded weight.

## 4. Frequency baseline and edge estimation

Raw co-occurrence count is insufficient. Every scored edge MUST compare observed proximity to an expected value derived from endpoint frequency and exposure. The experiment MUST evaluate at least one smoothed lift/PMI-family statistic and one temporal-permutation or shuffled-order control.

A canonical logged statistic is:

```text
association = log((observed + epsilon) / (expected + epsilon))
```

`expected` MUST be computed within the same eligible population, time scale, session policy, and sampling exposure as `observed`. `epsilon`, smoothing prior, minimum support, confidence interval, multiple-testing treatment, and high-frequency stop-node policy MUST be preregistered.

An edge MUST store endpoint revisions, scale, observed and expected mass, support count, score, uncertainty, evidence-pair sample, estimator revision, and last update. A high score with insufficient support MUST remain a candidate and MUST not enter retrieval.

Temporal shuffling SHOULD reduce the association signal. Failure to degrade under shuffle is evidence that the method may be learning semantic/frequency artifacts and MUST block promotion for the claimed temporal effect.

## 5. Retrieval experiment

The treatment retrieval pipeline is:

```text
baseline lexical+dense seed search
-> map seeds to eligible node revisions
-> bounded one-hop association expansion
-> select representative visible evidence
-> joint rerank with baseline candidates
-> diversity and token budget
-> provenance-preserving results
```

Stable defaults for an online experiment MUST cap seed count, edges per seed, total expanded candidates, evidence per edge, and token budget. Expansion is one hop. Multi-hop expansion is a separate experiment and MUST be disabled in the first canary because of combinatorial growth and semantic drift.

An expanded result MUST identify the seed, edge, score, scale, support, and evidence. The caller MUST be able to distinguish semantic retrieval from association expansion. Authorization filtering applies before and after expansion; an edge MUST not reveal the existence of inaccessible evidence.

## 6. Benchmark construction

The Dolly-specific benchmark MUST contain repeated A/B proximity where A and B are deliberately semantically dissimilar, plus:

- C, semantically similar to A but never co-occurring;
- D, globally frequent and often near B only by base rate;
- one-off salient events;
- incorrect and adversarial associations;
- shuffled-order copies;
- cross-session persistent entities;
- multiple granularities and overlapping membership;
- missing timestamps, duplicate events, and noise Blocks;
- queries where no expansion should occur.

Splits MUST group entity templates and generation families to prevent memorizing surface pairs. Held-out tests MUST include new A/B surfaces and new sessions.

Primary metrics SHOULD include association Recall@k and Precision@k on semantic-retrieval failures. Required diagnostics include false expansion rate, abstention, temporal-shuffle degradation, evidence precision, downstream answer/task accuracy, added tokens, latency, storage, and unauthorized-edge leakage.

## 7. Baselines and ablations

Experiments MUST compare:

1. lexical+dense baseline without expansion;
2. raw nearby-Block expansion;
3. raw co-occurrence count;
4. semantic node similarity without temporal score;
5. frequency-corrected association;
6. frequency-corrected association with temporal order shuffled;
7. single-scale versus multi-scale;
8. source-unit versus multi-granularity nodes.

Ablations MUST hold retrieval/token budget constant. Improvements obtained only by returning more context MUST be reported as a budget increase, not association quality.

## 8. Safety and promotion constraint

The subsystem MUST remain shadow-only until it improves the preregistered association primary metric on held-out data, meets baseline non-inferiority on ordinary queries, stays within false-expansion and cost limits, passes temporal-shuffle and authorization controls, and preserves evidence precision.

Even after product promotion, the relation name remains association. Causal inference requires a separate data model and research program. Association edges MUST never become durable facts, Skills, Reflection Policies, or prompt rules without independent evidence and promotion.
