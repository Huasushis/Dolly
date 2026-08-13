# Multi-Agent Topology Research Specification

Status: **Experimental**. Dolly v1 stable topology is explicit, static, validated configuration.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative for the experiment and its safety boundary.

`REQ-TOPO-001` — Any multi-agent topology conclusion or promoted capability
MUST satisfy every normative treatment, fairness, held-out task, failure,
budget, permission, ablation, and promotion obligation in this chapter.

## 1. Question and invariant boundary

This research asks whether a Page/Module network improves reliability, task switching, tool use, and long-term learning over a conventional single-agent loop at equal model and resource budgets.

Experimental Modules MUST use the same Core delivery, capability, side-effect, secret, Asset, and observability semantics as stable Modules. A topology decision MUST NOT grant tools, Pages, credentials, budgets, or management actions that were not present in its declared maximum capability envelope.

## 2. Required treatment arms

At minimum, the experiment MUST compare:

### A. Direct main agent

External input reaches the main LLM; Memory and tools are directly available to it.

### B. Manually specialized workers

The main LLM communicates with explicitly prompted tool, Memory, and review workers.

### C. Isolated main agent

External input, Memory, and tools reach worker Modules; the main LLM communicates only through the worker layer.

### D. Emergent division of labor

Eligible worker LLMs begin with the same base descriptor and capability envelope. The experiment observes whether stable roles emerge without assigning semantic role names.

Module IDs and presentation order SHOULD be randomized or neutralized to prevent accidental role cues. Any topology-specific extra context or coordination messages count against the common budget.

## 3. Fairness controls

Unless it is the declared factor, arms MUST share:

- main and worker model snapshots;
- total input, output, and reasoning-token limits;
- maximum provider requests and concurrency;
- tool set, permission envelope, sandbox, and external environment snapshot;
- retry, timeout, temperature, seed, and context-retention policy;
- Memory corpus and index revision;
- task time and monetary-cost limits;
- evaluation and final-state verifier.

If an arm cannot use an equal budget, results MUST be presented as a quality-cost frontier rather than a pure topology effect. Idle or failed worker calls count toward allocated resources according to the preregistration.

## 4. Tasks and splits

The suite MUST include simple tasks where coordination should not help, parallelizable tasks, tool tasks, long-horizon stateful tasks, conflicting evidence, task interruption/resumption, cross-session Memory, and adversarial worker error. It SHOULD include BFCL-style tool calls, state-verified user/tool interaction, browser tasks, and Dolly-specific long-term tasks.

Topology prompts, routing thresholds, and role-discovery criteria are tuned only on training/development data. Held-out tasks MUST include unseen surface domains and worker-failure patterns. Repeated runs and seed policy follow `method.md`.

## 5. Outputs and metrics

Primary task success MUST use environment state or evidence verification. Required metrics include pass@1, repeated-run success probability, configured pass^k, tokens, cost, wall time, tool error, unsafe/unauthorized proposal, duplicate work, inter-Module Blocks and bytes, main-agent context occupancy, Page lag, worker utilization, and recovery after worker failure.

Role analysis MUST measure specialization stability, role drift, redundant work, coordination deadlock, information bottleneck, false trust in a weak worker, and whether roles persist on held-out tasks. Emergent roles MUST be inferred with a preregistered classifier or rubric and validated against blinded human labels; cherry-picked transcripts are not sufficient.

The study MUST report per-task distributions and failure taxonomy. Aggregate success MUST not hide catastrophic regressions on simple or safety-critical tasks.

## 6. Self-organization constraints

In arm D, agents MAY propose routing or role labels only inside a configured sandbox topology envelope. Proposals MUST be schema-validated and versioned. They MUST NOT create executable code, install Extensions, grant capabilities, alter secrets, or mutate the active graph directly.

The first online study MUST be advisory/shadow: proposals are logged while a static topology runs. A later canary MAY select among a finite prevalidated topology set at task boundaries. Arbitrary runtime graph construction is outside v1 and requires a separate safety review.

Topology changes MUST not occur during an Activation. In-flight deliveries remain bound to the old graph revision; a transactional Core reconfiguration is required before new deliveries use another revision.

## 7. Ablations

Required ablations SHOULD isolate worker count, worker model strength, manual role prompt, tool isolation, Memory isolation, reviewer, communication budget, shared versus separate context, and routing policy. An “all features” arm without these ablations cannot identify why it improved.

The direct-main baseline MUST be tuned competently and receive the same accessible information. A deliberately weak single-agent prompt is not an acceptable control.

## 8. Promotion constraint

A topology MAY advance only if it improves the preregistered held-out objective at an acceptable quality-cost frontier, is non-inferior on simple/control tasks, stays within coordination and latency bounds, contains worker errors without permission escalation, and remains recoverable when any one nonessential worker crashes.

Evidence for one fixed topology does not justify autonomous topology evolution. Each increase in graph autonomy follows `promotion-gates.md` independently.
