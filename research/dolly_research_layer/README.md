# Dolly Research Layer

Status: **component research package**, 2026-08-26  
Branch: `research/dolly-layer-2026-08-26`

This directory turns Dolly's research ideas into falsifiable, executable studies. It is intentionally separate from the Rust runtime. The runtime correctness layer remains frozen: immutable Blocks, leased Activations, generation fencing, atomic output/cursor commit, bounded queues, quotas and crash recovery are not research variables.

## What is completed here

`run_suite.py` executes deterministic synthetic studies for:

1. temporal association beyond semantic similarity;
2. typed overlapping memory nodes versus one flat cluster partition;
3. deterministic, stochastic and dependency-aware context retention (`tensity`);
4. fixed, debounce, watermark, AIMD and PI activation scheduling;
5. single-agent and several multi-agent topology regimes under equalized call costs;
6. free-growing reflection versus a scoped candidate pool with replay/rollback;
7. procedural memory, cross-domain trajectory matching, DTW and negative-transfer gates;
8. LevelUpper cycle handling, origin provenance, deduplication and trust regimes;
9. Testament replay, module remapping, fan-out and curriculum deduplication;
10. the raw/derived Asset provenance contract for multimodal representations.

`test_suite.py` asserts reproducibility and architecture invariants. The GitHub workflow runs the tests, runs the full suite, and uploads `metrics.json`, `metrics.csv`, `summary.md`, `report.html`, `manifest.json` and a ZIP.

## Run

```bash
cd research/dolly_research_layer
python -m unittest -v test_suite.py
python run_suite.py --out out
```

The suite uses only Python's standard library. A quick local pass is available with `--quick`.

## Evidence classes

Do not merge these classes in a report:

| Class | Meaning | This package |
|---|---|---|
| E0 | Contract/invariant reasoning | yes |
| E1 | Deterministic synthetic component experiment | yes |
| E2 | Public dataset with deterministic validator | adapter plan only |
| E3 | Public dataset with a fixed live/local model | not run here |
| E4 | Real Dolly runtime integration/fault test | not run here |
| E5 | Controlled user canary | not run here |

Every generated artifact says `synthetic_component_screening`. A strong synthetic result can reject an unsafe design or justify an interface, but it cannot establish real-model task gains.

## Decisions produced by the suite

| Topic | Current decision |
|---|---|
| Temporal association | Implement a **one-hop**, evidence-bearing, frequency-normalized, multi-scale candidate behind a feature flag. Keep a temporal-shuffle negative control and an abstention threshold. Never label it causal. |
| Clustering | The data model should allow overlapping typed Entity, Concept, Episode and Procedure nodes. The online clustering algorithm remains experimental. |
| Tensity | Reject stochastic deletion as a default. Keep `tensity` as a bounded hint; any production context policy must be deterministic and dependency-group-aware. It never controls durable GC. |
| Scheduler | Keep debounce as the default; an optional high-watermark fast path is reasonable. PI/AIMD must win graph-level tests before promotion. |
| Topology | Keep static topology and one main brain as the default. Manually configured experts may be enabled per benchmark. Self-division is not a default. |
| Reflection | Adopt a versioned candidate pool, evidence links, scoped activation, held-out replay and rollback. Do not directly append daily reflection to a permanent system prompt. |
| Procedural memory | Store procedures separately from executable Skills, with preconditions, steps, success/failure evidence and counterexamples. |
| Trajectory abstraction | Structure-masked/DTW retrieval is promising only as an experiment. Missing applicability conditions must force abstention. |
| Testament | Treat it as an **offline replay, curriculum and evaluation harness**, sharing immutable snapshots with Dolly. It is not a live self-modifying Extension. |
| LevelUpper | New local Block ID, preserved remote origin ID, content hash, route, hop limit, dedupe and trust metadata are mandatory. Transport correctness and epistemic trust are separate. |
| Multimodal representation | Preserve raw Assets and versioned derived views. There is not yet enough evidence to choose transcript, frames, captions or raw media as the universal representation. |

## Literature map

The literature is used to choose baselines and failure controls, not to inherit claims uncritically.

### Long-term memory and evaluation

- [LongMemEval](https://arxiv.org/abs/2410.10813) separates information extraction, multi-session reasoning, temporal reasoning, knowledge update and abstention. Dolly should report both retrieval evidence and downstream answer correctness.
- [LoCoMo](https://arxiv.org/abs/2402.17753) adds long multi-session conversations, temporal/causal questions, summarization and multimodal turns.
- [MemoryAgentBench](https://arxiv.org/abs/2507.05257) stresses retrieval, test-time learning, long-range understanding and selective forgetting under incremental interaction.
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493) is especially relevant to Testament and procedural memory: it evaluates static state, dynamic state, workflows, environment gotchas and premise awareness over agent trajectories, while making accuracy/latency trade-offs explicit.
- [MemGPT](https://arxiv.org/abs/2310.08560) motivates hierarchical/virtual context management, but Dolly should preserve dependency groups rather than treating context entries as independent pages.
- [Mem0](https://arxiv.org/abs/2504.19413), [A-MEM](https://arxiv.org/abs/2502.12110), [HippoRAG](https://arxiv.org/abs/2405.14831) and [Zep/Graphiti](https://arxiv.org/abs/2501.13956) provide useful extraction, graph and temporal baselines. Their reported benchmark scores are not interchangeable because readers, judges, prompts, corpora and accounting differ.

### Association and temporal structure

- [Predictive Associative Memory](https://arxiv.org/abs/2602.11322) directly studies retrieval from temporal co-occurrence rather than embedding similarity. Its temporal-shuffle control is adopted here. The paper uses a controlled synthetic setting, so Dolly first implements a transparent statistical baseline before considering a learned predictor.
- Dolly's candidate score combines multiple time/event scales, subtracts a shuffled-frequency baseline, shrinks low-support edges, retains evidence pairs and expands only one hop by default.

### Context compression and forgetting

- [Lost in the Middle](https://arxiv.org/abs/2307.03172) shows that simply retaining a long context does not imply robust use of its middle.
- [LongLLMLingua](https://arxiv.org/abs/2310.06839) motivates task-aware compression, but its token-level methods do not remove Dolly's obligation to keep tool transactions and referenced dependency groups atomic.
- Recent selective-forgetting proposals are useful candidates, not permission to make random deletion part of cursor, Block, Asset or retry correctness.

### Reflection, procedures and skills

- [Reflexion](https://arxiv.org/abs/2303.11366) and [ExpeL](https://arxiv.org/abs/2308.10144) show that verbal feedback and extracted experience can improve repeated or related tasks.
- [Voyager](https://arxiv.org/abs/2305.16291) demonstrates an executable skill library in a controlled environment. Dolly deliberately inserts a promotion boundary: Procedure record -> validated candidate Skill -> enabled Skill.
- These works motivate learning, but do not justify silently rewriting Dolly's permanent identity or enabling newly generated code without held-out regression and permission checks.

### Multi-agent organization

- [AgentVerse](https://arxiv.org/abs/2308.10848) supplies a collaboration baseline, while [More Agents Is All You Need](https://arxiv.org/abs/2402.05120) is also a sampling-and-voting baseline rather than proof that role networks are always better.
- [When Do Multi-Agent Systems Help?](https://arxiv.org/abs/2607.16133) frames multi-agent relay as an information bottleneck: compression may remove redundant context or destroy task-relevant information. This is directly aligned with Dolly Pages and bounded Block exchange.
- [Peacemaker or Troublemaker](https://arxiv.org/abs/2509.23055) identifies sycophancy and premature consensus as failure modes. Dolly's topology benchmark therefore records correlated error and role drift, not only average success.

### Agent/tool evaluation

- [tau-bench](https://arxiv.org/abs/2406.12045) uses final database state and `pass^k`, making it a better end-to-end reliability gate than “the model returned a plausible answer”.
- [GAIA](https://arxiv.org/abs/2311.12983) covers reasoning, web, tools and multimodality.
- BFCL's official executable harness should be used for tool-call syntax, parallel calls, multi-turn state and relevance detection; it is a model/adapter gate, not a memory benchmark.

## Public benchmark ladder

Run in this order after a stable text LLM and Memory baseline exist:

1. **LongMemEval oracle**: reader correctness with supplied evidence.
2. **LongMemEval-S cleaned**: retrieval + reader, report session/turn recall and QA by category.
3. **LoCoMo**: categories 1–5 must be reported separately; preserve exact scorer/judge protocol and question accounting.
4. **MemoryAgentBench**: incremental insert/update/forget behavior.
5. **LongMemEval-V2 small**: procedure/environment memory, evidence latency and compactness.
6. **BFCL**: Provider Adapter and tool loop.
7. **tau-bench / tau2-bench**: policy, tool and final-state reliability with repeated trials.
8. **GAIA / browser benchmark**: only after browser, media and sandbox traces are reproducible.

For every run record dataset commit/hash, split, model snapshot, exact prompts, tokenizer, context budget, random seed, call count, retries, token/cost accounting, per-case outputs, deterministic validation and paired uncertainty. Never silently substitute a fake backend after a live failure.

## Required real-data experiments before production promotion

### Association graph

Use real Dolly histories plus a manually annotated set containing:

- semantically dissimilar but repeatedly adjacent pairs;
- semantic distractors that never co-occur;
- globally frequent concepts;
- one-off dramatic events;
- session-boundary cases;
- stale and corrected associations;
- explicit “no useful association” queries.

Report Precision/Recall@k, false expansion, abstention, evidence precision, token overhead, downstream QA and the temporal-shuffle drop.

### Tensity/context policy

Replay identical Activation traces under deterministic baseline, stochastic tensity, deterministic tensity and dependency-group-aware policies. Tool-call/result/continuation groups, BlockRef groups and current-Activation inputs are indivisible. Report seed variance and exact broken-dependency cases.

### Scheduler

The component simulator is not enough. Run chain, fan-in, fan-out, diamond, cycles, shared-node cycles, burst, overload, slow provider and mixed-cost graphs through the real Runtime with a virtual clock and fault injection. No strategy may violate hard maximum latency, starve a subscriber or destabilize another branch.

### Topology

Use paired tasks and equal total model/tool/token/time/information budgets. Compare one main brain, sampling/voting, manually separated experts, isolated main brain and self-division. Publish per-case deltas, communication bytes, relay compression loss, role drift, correlated failures and paired bootstrap confidence intervals.

### Testament

The minimum viable research product is:

```text
immutable runtime snapshot
+ activation/event journal
+ source-module -> target-module(s) mapping
+ deterministic fake providers/tools
+ curriculum selector
+ candidate memory/reflection/procedure writer
+ held-out and negative-transfer evaluator
+ diffable promotion bundle
```

It must never write directly into the live instance. Promotion imports a signed/versioned bundle through the normal configuration and memory APIs after review.

### LevelUpper

Transport conformance precedes intelligence claims. Test disconnect/reconnect, duplicate frames, out-of-order frames, cycle rebroadcast, hop expiry, origin collision, Asset remapping, partial Asset transfer, malicious metadata, trust downgrade and unknown delivery outcome. A remote Block is imported as a new local Block while preserving immutable remote provenance.

## Source limitation

The user selected the Consensus connector, but its account returned “all 30 searches this month used; reset September 1” during this run. The review therefore uses paper originals and official benchmark repositories instead. This limitation affects source acquisition only; it does not change the deterministic experiment results.
