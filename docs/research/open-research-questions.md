# Open Research Questions

Status: Draft

## 1. Purpose and authority

This document is a research plan. It is not a contract and it does not authorize any
default behavior. It surveys existing work for five mechanisms the project owner
proposed, states what is already supported by published research or industrial
practice, states what is still an unverified hypothesis, and defines the experiment
that would settle each one.

Authority order is unchanged. `docs/takeover/confirmed-user-requirements.md` records
`OWNER-RESEARCH-001`: additive increase/multiplicative decrease (AIMD) scheduling,
tensity, cognitive memory mechanisms, trajectory matching, and similar ideas are
research hypotheses and must not become defaults before controlled experiments
support them. `docs/spec/core-runtime.md` §13.4 and `docs/spec/memory-extension.md`
§14 already list these mechanisms as experimental and disabled by default. Every run
described here is bound by `docs/experiments/protocol.md`: preregistered hypothesis,
declared baseline, separated tuning and evaluation data, machine-readable manifest,
retained failed runs, and no silent fallback from a live backend to a fake one.

Nothing below overrides those documents. Where this document proposes a threshold or
an effect size, that number is a proposal to be frozen before a held-out run, not an
accepted contract value.

## 2. How to read the evidence labels

Each claim carries one label.

- **Supported**: published peer-reviewed work or documented production behavior in a
  widely used system supports the claim as stated.
- **Partially supported**: related work exists, but it was validated on a different
  problem, a different data type, or under assumptions Dolly does not satisfy.
- **Hypothesis**: no evidence was found either way. It may still be correct. It must
  be treated as unknown until an experiment reports.

A label describes the state of external evidence, not the quality of the idea.

Two review conclusions apply to the whole document and are stated once here.

First, several of the owner's diagnoses are correct even where the owner's proposed
solutions are not. The owner is right that plain vector search plus reranking only
answers direct lookup and does not retrieve by shared relational structure
(Section 5). The owner is right that daily summarization invents details that were
not in the source (Section 6). The owner is right that a fixed prompt plus a recent
window cannot accumulate improvement (Section 6). Those three observations match the
literature. The proposed remedies are where the risk sits.

Second, the largest single risk across all five questions is building an estimator
for a quantity Dolly can already measure exactly. That is the core objection to AIMD
in Section 3 and it recurs in Section 4.

## 3. Question 1: adaptive scheduling by downstream pressure

### 3.1 Precise statement

The owner proposes a control loop modeled on TCP congestion control. After a Module
run, if the pending input that accumulated during the run exceeds what the run
consumed, or if service time exceeded the configured period, the Core reduces the
activation frequency of that Module's direct upstream Modules — the Modules that
publish to a Page this Module consumes. Otherwise the Core increases it. Increase is
additive, decrease is multiplicative.

Restated as a testable claim: *for a Page graph with cycles, fan-in, and fan-out, an
AIMD controller over upstream activation frequency produces lower end-to-end latency
at equal throughput than a policy that derives eligibility directly from the measured
per-consumer pending count and bytes.*

Two variables must be separated before any experiment. AIMD in TCP controls a
congestion window, that is, the amount of outstanding unacknowledged data. The owner's
proposal controls activation frequency, that is, a rate. Window control and rate
control have different stability properties, and `core-runtime.md` §13.4 already
requires an AIMD experiment to declare which variable it controls. This document
recommends that the first experiment control exactly one variable.

### 3.2 What established practice does

Every widely deployed dataflow system solves this problem, and none of them solves it
with a rate estimator.

- **Apache Flink** uses credit-based flow control. Each downstream subtask reports the
  number of free input buffers it has as credits; an upstream producer may send a
  buffer only if it holds a credit. Flink adopted this specifically to replace
  reliance on TCP-level backpressure, because TCP backpressure blocked the shared
  socket for unrelated tasks and delayed the signal by propagating hop by hop.
  Supported. See FLINK-7282 and the Flink network stack deep dive.
- **Reactive Streams**, and its implementations including Akka Streams and Project
  Reactor, mandate that a Subscriber signals demand through `Subscription.request(n)`.
  A Publisher may not emit more than the demand it has been granted. The specification
  states that mandatory backpressure is what allows unbounded buffers to be avoided.
  Supported.
- **Apache Storm** 1.0 added automatic backpressure using configurable high and low
  watermarks on a task's receive queue: crossing the high watermark throttles the
  topology's spouts, and throttling stops at the low watermark. Before that, the only
  control was `topology.max.spout.pending`, a fixed outstanding-tuple bound.
  Supported.
- **Twitter Heron** uses TCP backpressure between stream manager and instance plus
  spout backpressure, where a stream manager that detects a slow instance stops
  reading from its local spouts. Heron's stated motivation was that Storm at the time
  had no backpressure at all and dropped tuples, making system behavior unpredictable.
  Supported.
- **Netflix `concurrency-limits`** does use AIMD, and also gradient and Vegas-style
  delay-based limiters. Its scope is the concurrency limit toward a *remote* service
  whose queue the client cannot observe. Netflix recommends a delay-based limiter on
  the server and a loss-based limiter such as AIMD on the client. Supported.

The pattern is consistent. When the consumer's queue occupancy is directly
observable, systems transmit it exactly as credits, demand, or watermarks. AIMD is
used when occupancy is *not* observable and must be inferred from loss or latency.

### 3.3 Why this matters for Dolly specifically

Dolly is in the observable case. `core-runtime.md` §12 already requires finite
per-consumer pending count and byte limits with an explicit backpressure policy and
forbids silent dropping. §13.2 already puts `pendingCount`, `pendingBytes`,
`maxPendingCount`, `maxPendingBytes`, and a three-valued `availability` for every
downstream Module into the scheduler snapshot. That snapshot already carries the
information a credit scheme would transmit. An AIMD loop would discard that exact
signal and re-estimate it from a noisy proxy.

Three further mismatches with the TCP setting are worth stating.

- **Feedback delay.** TCP's control interval is one round-trip time, typically
  milliseconds. Dolly's control interval is one Module run, which for a Module that
  calls a language model is seconds to minutes. A controller whose feedback arrives
  one run late, acting on a rate that takes several runs to take effect, is operating
  with a loop delay comparable to its settling time. Delayed feedback is the
  documented cause of queue oscillation in congestion control, where senders respond
  at least one round-trip late and alternately over- and undersupply the link.
  Supported for networks; the transfer to Dolly is Partially supported, because the
  delay ratio is worse here, not better.
- **The convergence proof does not transfer.** Chiu and Jain (1989) proved AIMD
  converges to efficiency and fairness under a specific model: a single shared
  bottleneck with synchronized binary feedback to all flows. Dolly has one bottleneck
  per Module, asynchronous feedback, and fan-in where one upstream Module feeds
  several downstream Modules with different capacities. Citing AIMD's convergence
  result for Dolly's graph is a misapplication. Supported, as a negative statement
  about scope.
- **Cycles.** The Page graph may contain cycles, including self-loops. In a cycle, a
  Module throttles an upstream Module that is transitively its own downstream. The
  control signal becomes a feedback path, and the fixed point at rate zero is
  reachable and stable. `core-runtime.md` §12 already requires detecting sustained
  no-progress states; an AIMD controller makes reaching them easier, not harder.
  Hypothesis in the specific form, but the mechanism is a direct consequence of the
  loop topology and is cheap to demonstrate in simulation.

### 3.4 Falsifiable hypotheses

- **H1-A**: On a topology set containing a line, fan-in, fan-out, a diamond, a
  self-loop, and a two-Module cycle, AIMD reduces p95 end-to-end Block latency by at
  least 20 percent relative to a watermark policy derived from per-consumer pending
  state, at equal or higher throughput.
- **H1-B**: AIMD does not increase the number of runs that produce no useful output
  relative to the same baseline.
- **H1-C**: AIMD reaches a stable operating point on every cyclic topology within a
  declared settling bound and never enters a sustained no-progress state that the
  baseline avoids.
- **H1-D** (separate scope, likely to survive): For calls to an external model
  provider, an AIMD or delay-based concurrency limiter reduces provider error rate
  (HTTP 429 and timeouts) at equal or better throughput compared with a fixed
  concurrency cap.

H1-D is the hypothesis this document expects to hold, because it is the case where
the queue is genuinely unobservable and where Netflix's library is deployed evidence.

### 3.5 Minimal baseline

Two baselines, both required.

1. **Fixed policy**, exactly `core-runtime.md` §13.3: reactive Modules run when data
   is pending and the actor is idle; bounded queues apply deterministic backpressure;
   retries use bounded exponential backoff.
2. **Watermark policy**: a Module is ineligible while any downstream consumer's
   pending count or bytes is above a high watermark, and becomes eligible again below
   a low watermark. Aggregation across downstream consumers is the strictest
   consumer. This is Storm's mechanism restated in Dolly's vocabulary and is a
   near-free addition, since §13.2 already supplies the inputs.

Baseline 2 is the honest comparison target. Comparing AIMD only against baseline 1
would credit AIMD for the benefit of using downstream pressure at all, which any
policy can have.

### 3.6 Metrics and minimum useful effect

Primary: p95 end-to-end latency from source Block creation to sink consumption, at
matched throughput. Minimum useful effect: 20 percent reduction with a paired
bootstrap 95 percent confidence interval excluding zero.

Secondary, all reported, none allowed to regress beyond its declared bound:

- throughput in Blocks per simulated second and in bytes per simulated second;
- backpressure stall time per Module;
- oscillation, measured two ways: coefficient of variation of the controlled variable
  in steady state, and count of direction reversals per unit time;
- settling time to within ±10 percent of the steady-state value of the controlled
  variable;
- fairness across sources, using Jain's fairness index over per-source completed
  Block counts;
- incidence of sustained no-progress states, which must be zero;
- parameter sensitivity: results for a grid over the additive step and the
  multiplicative factor, reported in full rather than at a tuned point.

Parameter sensitivity is not optional. `core-runtime.md` §13.4 requires parameter
provenance, and an AIMD result that only holds at one hand-picked parameter pair is
not evidence.

### 3.7 Data and cost

A deterministic discrete-event simulator with a virtual clock, no language model
calls, and no wall-clock sleeps. Service time per Module drawn from a declared
distribution with a declared seed. Suggested matrix: 6 topologies × 3 offered-load
levels (under, at, and over capacity) × 30 seeds × 3 policies × the parameter grid.
This is free apart from compute and it satisfies Gate 0 as a bounded standalone
simulator that cannot reach product paths. Gate 3 then requires replaying the winning
policy through the real Dolly Core rather than the simulator.

The simulator must be validated against the real runtime on at least the line and
fan-in topologies before its comparative results are believed. A simulator that
disagrees with the runtime is measuring itself.

### 3.8 Failure criteria

Reject AIMD as a default if any of these hold.

- It fails to beat the watermark baseline by the declared minimum effect.
- It produces a sustained no-progress state on any cyclic topology that the baseline
  handles.
- Its advantage exists only inside a narrow parameter region, defined as fewer than
  half the grid points beating the baseline.
- Its oscillation measure exceeds the baseline's while its latency advantage is inside
  the confidence interval of zero.

### 3.9 If the answer is negative

The fallback is already specified and costs nothing to adopt: keep §13.3 as the
default and add the watermark rule as a selectable policy behind the §13.2 interface.
That is the mainstream industrial answer and it is what Flink, Storm, Heron, and
Reactive Streams converged on. Move the AIMD work to H1-D, provider-facing
concurrency, where the evidence base actually supports it.

**Gating verdict**: experiment required before implementation for the internal
scheduler. The watermark baseline may be implemented now without an experiment,
because it is a direct use of already-specified per-consumer limits, not an adaptive
mechanism.

## 4. Question 2: tensity as an importance value with weighted random eviction

### 4.1 Precise statement

Tensity is a per-Block floating point number, standard value 1.0, described in the
owner's source text as representing the information strength of a Block and as
controlling roughly how long that Block survives in a context. The proposed mechanism:
when a language-model Module's retained context approaches its limit, evict Blocks at
random with weight proportional to 1/tensity until the context fits, so that expected
survival time is proportional to tensity.

### 4.2 The mathematics of the proposed rule

The proportionality claim is correct under assumptions Dolly does not satisfy.

Let the retained set be `R`, `n = |R|`, and Block `i` have tensity `t_i > 0`. One
eviction step removes Block `i` with probability `p_i = (1/t_i) / S`, where
`S = Σ_{j∈R} 1/t_j`. If `R`'s composition were held fixed and eviction steps arrived
at a constant rate `λ`, survival is geometric with parameter `p_i`, so the expected
number of steps before Block `i` is evicted is `1/p_i = t_i · S`, and the expected
lifetime is `t_i · S / λ`. Expected lifetime is therefore proportional to `t_i`. That
much is sound.

Three properties of the real setting break the claim.

- **`S` is not constant, and it drifts in a direction that removes the time scale.**
  Eviction preferentially removes low-tensity Blocks, so the retained set drifts
  toward higher tensity, `S` falls, and every surviving Block's expected lifetime
  rises. Relative lifetimes stay proportional to tensity at any instant, but the
  constant `S/λ` is a function of the tensity distribution of whatever else happens to
  be in the window. Consequence: the owner's request to calibrate tensity 1.0 to last
  about one day is not answerable as a constant. There is no setting of tensity that
  yields a fixed absolute half-life independent of workload. This is the single most
  important finding in this section.
- **Eviction is triggered by tokens, not by Block count.** A step frees `s_i` tokens.
  The runtime must repeat steps until the budget is met, so the step count per trigger
  depends on the size distribution, and `λ` is not constant. Because selection ignores
  `s_i`, large Blocks are evicted too rarely relative to the space they occupy. The
  established fix is a size- and cost-aware policy, of which GreedyDual-Size (Cao and
  Irani, 1997) is the canonical form. Supported.
- **Blocks are not independent items.** See §4.4.

### 4.3 What established practice does

- **Sliding window and summarization compaction** are the default in production
  assistants: keep a protected recent window verbatim, replace older content with a
  summary. Supported as practice.
- **MemGPT** (arXiv 2310.08560) treats the context window as paged memory with an
  explicit hierarchy, and gives the model functions to move data between main context
  and external storage. Eviction is an explicit, inspectable operation, not a random
  one. Supported.
- **Generative Agents** (Park et al., 2023) score memories as a weighted sum of
  recency, importance, and relevance, with recency as exponential decay and importance
  assigned by the language model. The reported design uses all three terms.
  Importance alone was never the design. Supported.
- **MemoryBank** (arXiv 2305.10250, AAAI 2024) applies Ebbinghaus-style decay where
  accessed memories are reinforced and neglected ones fade. This is decay by access,
  not random eviction by a declared score. Supported as a published mechanism;
  its benefit over a recency baseline in Dolly's setting is Hypothesis.
- **Random cache replacement** is well studied and is generally worse than recency-based
  replacement on workloads with locality, though it degrades more gracefully than LRU
  on loops that do not fit and costs almost nothing to implement. Under Zipf-like
  popularity, LRU beats random for large enough skew. Supported.

Conversational context has strong recency locality: the question being answered is
usually near the end. That is precisely the workload shape where random replacement
is known to lose to recency-aware replacement.

### 4.4 Two failure modes specific to Dolly

Both are engineering consequences, not opinions, and both dominate the retrieval
question.

**Structural validity.** A retained context is not a bag of independent items. Removing
an arbitrary middle element breaks tool-call and tool-result pairing, breaks the
reasoning-content retention rule the owner quoted from the DeepSeek documentation, and
breaks referential coherence when a later Block says "that file". Any eviction policy
must operate on whole removable units that keep the request valid. This constraint
applies to the baseline too, but it removes most of the apparent simplicity of "pick a
Block at random and drop it".

**Prefix cache invalidation.** DeepSeek's context caching is automatic, prefix-based,
and reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; cache-hit input
tokens are billed at a lower rate. Removing a Block from the middle of the prompt
changes the prefix from that point onward, so every subsequent token misses. Random
per-turn eviction from the middle would convert cache hits into cache misses on nearly
every turn. Append-only compaction, which replaces the oldest span with one summary
and leaves the tail untouched, invalidates the prefix too, but rarely. This yields a
concrete measurable prediction and a required metric: cache hit ratio and cost per
task. Supported, from DeepSeek's published caching behavior.

### 4.5 Who sets tensity

The owner explicitly left this open. Four options, each verifiable.

- **A. The producing Module declares it.** Simplest, matches the owner's Block schema.
  Weakness: uncalibrated across Modules, and nothing makes one Module's 2.0 comparable
  to another's.
- **B. The Core computes it** from observable facts: source Module, payload size,
  duplicate arrival count, age, and modality. Deterministic, auditable, reproducible,
  and testable without any Module cooperation.
- **C. The consuming Module assigns it.** This is the theoretically correct location.
  Importance is not a property of a Block; it is a property of the pair (Block,
  consumer task). Two language-model Modules on the same Page have different needs
  from the same Block. A single scalar attached to the Block cannot express that.
- **D. Producer declares, Core normalizes** per source Module against that Module's own
  recent distribution, for example by rank within the last N Blocks from that source.
  This preserves the producer's ordering while making values comparable.

Recommendation for the first experiment: measure whether any of these carries signal
before choosing between them, using §4.6.

### 4.6 Falsifiable hypotheses

- **H2-A (predictive validity, the decisive cheap test)**: declared tensity predicts
  whether a Block is actually needed by later successful outputs, better than chance
  and better than the trivial predictors recency, byte size, and source Module.
  Ground truth by leave-one-out necessity: replay a recorded session, remove one Block
  from the context, and record whether the downstream deterministic task validator
  still passes. Metric: area under the ROC curve for predicting "removal breaks the
  task". If tensity's area under the curve is not meaningfully above recency's, tensity
  carries no information the runtime does not already have, and the entire mechanism
  falls regardless of how eviction is implemented.
- **H2-B**: tensity-weighted random eviction produces higher downstream task accuracy
  at equal token budget than append-only compaction with a protected recent window.
- **H2-C**: tensity-weighted random eviction produces higher accuracy than a
  deterministic lowest-score-first eviction using the same score. If false, the
  randomization is pure cost: it destroys reproducibility for no gain.
- **H2-D**: a duplicate-arrival adjustment, using a concave function of the arrival
  count as the owner suggested, improves accuracy over ignoring arrival count.

Note that H2-C isolates *randomization* from *scoring*. These are separate claims and
the owner's proposal bundles them. Randomization's only defensible benefit is
avoiding systematic starvation of a whole score band; that benefit should be measured,
not assumed.

### 4.7 Minimal baseline

Append-only compaction: keep the most recent K tokens verbatim, replace the oldest
span with a single summary Block when the budget is exceeded, never remove from the
middle. This is the sliding-window-plus-summary default, it preserves prefix caching,
it preserves structural validity by construction, and it is fully deterministic.

Second baseline: recency-only eviction of whole removable units, no scoring.

### 4.8 Metrics and minimum useful effect

- Downstream task accuracy on a held-out set, by deterministic validators.
- False use of removed content, that is, answers that assert facts only present in
  Blocks that were evicted.
- Prefix cache hit ratio and total cost per task.
- p50 and p95 latency per turn.
- Structural validity failures per 1000 requests, which must be zero for any policy
  that ships.
- Realized lifetime as a function of tensity, reported as a distribution, to test the
  proportionality claim of §4.2 empirically rather than assuming it.

Minimum useful effect for H2-B: 5 percentage points absolute accuracy at equal token
budget, with a paired bootstrap 95 percent confidence interval excluding zero, and no
more than a 10 percent increase in cost per task.

### 4.9 Data and cost

H2-A needs no live model calls beyond replay of already-recorded sessions and is the
cheapest decisive experiment in this document. Run it first.

H2-B through H2-D need live calls. LongMemEval (arXiv 2410.10813, ICLR 2025) provides
500 questions over chat histories of roughly 115k tokens each in its smaller setting,
which is the right shape for a context-management comparison; LoCoMo (ACL 2024,
`2024.acl-long.747`) provides 50 conversations averaging around 300 turns. Both are
public, which satisfies the protocol requirement that the default experiment path not
depend on private data. A paired run over a 150-question subset with three policies
and three seeds is roughly 1350 sessions; at the DeepSeek-class prices the owner is
targeting this is a bounded and declarable spend, and Gate 4 requires
`RUN_LIVE_INTEGRATION=1` plus a finite call and time budget regardless.

### 4.10 Failure criteria

- H2-A fails: tensity's discrimination is within noise of recency. Then tensity is
  removed from the design rather than retuned. Do not proceed to H2-B.
- H2-B fails: keep append-only compaction.
- H2-C fails: if deterministic eviction matches random eviction, drop randomization.
- Any policy that produces a nonzero structural validity failure rate is disqualified
  before accuracy is even considered.

### 4.11 If the answer is negative

Append-only compaction with a protected recent window is the fallback, and it is
already the industry default. The Block field may still exist as an inert annotation
for research runs, but `memory-extension.md` §14 already requires experimental
mechanisms to be off by default and to not alter baseline records or scores in place.
Nothing in the product depends on the outcome.

**Gating verdict**: experiment required before implementation. H2-A must run before
any code reads the field for eviction. Append-only compaction may be implemented now.

## 5. Question 3: three tiers of memory retrieval

### 5.1 Precise statement

The owner describes three retrieval capabilities: direct knowledge lookup; transfer or
analogy, described as applying or mapping a "group operation" from one body of
knowledge to another; and a sustained mode of thinking. The owner correctly observes
that embedding plus reranking serves only the first. Two concrete proposals are
attached: treat a sequence of vectors as a trajectory and match its shape, in the
manner of t2vec, possibly under orthogonal transformation; and tokenize text, delete
selected parts of speech, then embed the remainder in order to match abstract patterns
rather than topics.

### 5.2 Tier one: direct lookup

State of practice is settled and `memory-extension.md` §10.2 already specifies it:
lexical retrieval, vector retrieval within one compatible index generation, and a
named, versioned fusion such as reciprocal rank fusion. Supported.

Reranking is optional in the baseline and should stay optional. "Drowning in
Documents" (arXiv 2411.11767) shows that reranker quality improves as more candidates
are scored only up to a point and then degrades, with rerankers assigning high scores
to documents having no lexical or semantic overlap with the query. Practical candidate
depth is on the order of tens to a couple of hundred. Supported. This is a direct
argument for keeping reranking as a separately-configured bounded stage with its own
provenance, which is what §10.2 already says.

Query rewriting and HyDE (arXiv 2212.10496, ACL 2023) generate a hypothetical answer
document and embed that instead of the query. The paper's own framing is that the
generated document may contain false details and that the encoder's dense bottleneck
filters them. HyDE's reported gains are against unsupervised dense retrievers in the
zero-shot setting. Supported for that setting; Partially supported as a general
improvement, because it adds a generation call per query and its advantage narrows
when a strong first-stage retriever is available. For Dolly it is a candidate
optimization, not a baseline component.

### 5.3 Tier two: transfer and analogy

The owner's diagnosis is correct and has a literature. Relational similarity —
correspondence between relations — is distinct from attributional similarity, which is
correspondence between attributes, and standard embedding retrieval measures the
latter. Turney's Latent Relational Analysis and "Similarity of Semantic Relations"
(Computational Linguistics 32(3), arXiv cs/0608100) formalize exactly this
distinction; the Latent Relation Mapping Engine (arXiv 0812.4446) combines it with
Structure Mapping Engine ideas to build analogical mappings without hand-coded
representations. Supported.

What this means practically: there is prior art for the *goal*, it is decades old, it
operates at the level of word pairs and small mappings, and none of it has been shown
to work at the level of "retrieve a past episode whose structure matches this one" for
an agent. Treat the goal as legitimate and the scale as unproven.

**Evaluation of proposal one, part-of-speech removal before embedding.** Partially
supported, leaning negative. Probing work on sentence embeddings (Conneau et al.,
arXiv 1805.01070; Adi et al.'s word-order probe) shows sentence encoders retain
surface and lexical information strongly and encode word order and syntax more weakly,
and bag-of-words averages remain a strong baseline on many tasks. If encoders are
dominated by content words, deleting nouns leaves a residue that these encoders
represent least reliably, and the resulting vector may be closer to noise than to an
abstract pattern. One genuinely supportive data point exists: in word-embedding
evaluation, stopword filtering leaves semantic similarity roughly unchanged but
substantially helps *analogy* tasks. That is word-level analogy, not sentence-level
structural abstraction, so it raises the prior slightly without transferring. The
experiment is cheap and worth running to settle it.

The obvious competitor, which must be in the comparison, is to have a language model
write an explicit relational abstraction of the episode — for example a short
schema-like sentence naming the roles and the relation — and index that string
alongside the raw text as an additional view. This is ordinary multi-view indexing, it
requires no new embedding theory, and it is the outcome this document expects to win.

**Evaluation of proposal two, trajectory shape matching.** Partially supported, leaning
negative, and expensive. t2vec (Li, Zhao, Cong, Jensen, Wei; ICDE 2018) learns
fixed-dimensional trajectory representations using a sequence-to-sequence model with a
*spatial-proximity-aware loss* over a grid tokenization of geographic space. Two
things do not transfer. First, the loss and the tokenization are specifically spatial;
there is no analogous proximity structure over a sequence of sentence embeddings that
is known in advance. Second, t2vec requires training data and a training objective;
Dolly has neither for this task at the start. There is also published skepticism about
whether learned trajectory representations produce meaningful similarities at all
("How meaningful are similarities in deep trajectory representations?", Information
Systems, 2020). The orthogonal-transformation idea is not supported by anything found;
it is a Hypothesis, and note that most sentence embedding spaces are compared by cosine
similarity, which is already invariant to any orthogonal transformation applied to both
sides, so an orthogonal transform applied to both a query and a candidate changes
nothing. A transform applied to only one side needs an independent justification that
does not currently exist.

If sequence shape is to be tested at all, the correct first baselines require no
training: dynamic time warping over the embedding sequence, and simple window-pooled
embeddings. The null hypothesis — that a mean-pooled window embedding matches anything
the shape method achieves — is likely to hold.

### 5.4 Tier three: retrieval triggered by emotion or keyword combination

The owner's introspective observation is that a strong emotion or wish recalls past
episodes with the same emotion, and that keyword combinations trigger recall in
ordinary conditions.

Mood-congruent memory and mood-state-dependent retrieval are real, studied effects in
psychology. The meta-analytic picture is that effect sizes vary systematically with
method: effects are stronger with real-life material, with contrasting rather than
neutral-contrast moods, and with item-specific mood states, and mood-state-dependent
memory appears more often for positive than negative moods. Supported as psychology.

No evidence was found that emotion-tagged retrieval improves language-model agent task
performance. Hypothesis. `memory-extension.md` §14.2 already classifies emotion,
desire, and salience inference as sensitive derived data requiring explicit owner
policy, deletion and export support, and a documented harm evaluation, and warns that
constructing the evaluation label from the same intensity being evaluated is invalid.
That warning applies exactly here: an experiment where a model labels emotion and the
same model judges whether the recall was apt proves nothing.

Keyword-combination triggering, as distinct from emotion, is just lexical retrieval,
which the baseline already has.

### 5.5 Falsifiable hypotheses

- **H3-A**: hybrid lexical plus vector fusion beats each single channel on Recall@k and
  NDCG@k on Dolly's own held-out set. Expected to hold; run it because the baseline
  needs the number, not because the answer is in doubt.
- **H3-B**: on a set of query-target pairs that share relational structure but not
  topic, part-of-speech-ablated embeddings achieve higher Recall@k than full-text
  embeddings.
- **H3-C**: a model-written relational abstraction indexed as an additional view beats
  both full-text embeddings and part-of-speech ablation on the same set.
- **H3-D**: dynamic time warping over embedding sequences beats window-pooled
  embeddings on retrieving structurally similar episodes.
- **H3-E**: adding an emotion or intensity feature to the retrieval score improves
  downstream task accuracy, not merely subjective similarity.

### 5.6 Minimal baseline, metrics, data, and cost

Baselines: no memory; lexical only; vector only; hybrid fusion. These four are already
required by `docs/experiments/protocol.md` Gate 2 and `memory-extension.md` §17.1.

Metrics: Recall@k, NDCG@k or MRR, downstream answer correctness, false-memory use
rate, p50 and p95 indexing and query latency, storage growth, provider calls, and
cost. Minimum useful effect for H3-B and H3-C: 10 points Recall@10 over the full-text
embedding baseline on the structural set.

Data. H3-A can use LongMemEval and LoCoMo. H3-B through H3-D need a structural set that
does not exist and must be built: pairs of episodes sharing a relation but not a topic,
built by a procedure that does not use the embedding method being evaluated, with
tuning and held-out splits that do not share a source conversation. Budget this at
roughly 200 to 400 pairs. Building it honestly is the main cost of question 3, and the
protocol's requirement that ground truth be independent of the feature being evaluated
must be enforced when doing so: if a language model both invents the pairs and scores
the retrieval, the result is circular.

### 5.7 Failure criteria and negative outcome

Reject part-of-speech ablation if H3-B fails or if H3-C beats it, which would make it
strictly dominated by a simpler method. Reject trajectory matching if H3-D fails, and
note that its cost bar is higher than its accuracy bar: it must justify sequence
storage and matching cost, not merely tie.

If tiers two and three both fail, the fallback is the specified hybrid baseline plus
one optional extra indexed view produced by a model, which is ordinary practice. The
owner's *diagnosis* would still stand: the system would remain unable to retrieve by
shared structure, and that would be a documented limitation rather than a silently
broken feature.

**Gating verdict**: tier one may be implemented now; it is already specified. Tiers two
and three require experiments before any default behavior. Automatic recall stays
disabled by default per `memory-extension.md` §10.1 regardless of these results.

## 6. Question 4: daily summary, skill distillation, and a long-lived prompt

### 6.1 Precise statement

Three linked proposals. First, a periodic summary over the day's Blocks. Second,
distillation of that summary into reusable skills owned by the Memory extension,
created or edited through a find-then-decide loop. Third, maintenance of one
continuously updated prompt describing a mode of thinking, so the agent accumulates
improvement that a fixed system prompt cannot provide.

### 6.2 What established practice does

- **Reflection over a memory stream**: Generative Agents triggers reflection when the
  cumulative importance of recent events crosses a threshold, roughly two to three
  times per simulated day. Supported. Note that the trigger is event-driven, which is
  also what `memory-extension.md` §14.1 requires: the window is identified by a
  runtime-issued source activation request, not a local date or a sleep.
- **Skill libraries**: Voyager stores skills as executable code retrieved by embedding
  over the description, so execution is deterministic even though retrieval is fuzzy.
  Supported, and the lesson transfers directly: a skill that can be *executed and
  verified* is worth far more than a skill that is prose an agent may or may not
  follow.
- **Insight extraction from trajectories**: ExpeL aggregates recurring patterns across
  trajectories into reusable insights. Agent Workflow Memory (arXiv 2409.07429, ICML
  2025) induces reusable routines from agent trajectories and reports 24.6 percent and
  51.1 percent relative gains in success rate on Mind2Web and WebArena. Supported.
- **Evolving instructions rather than rewritten prose**: Agentic Context Engineering
  (arXiv 2510.04618) names two failure modes for exactly the owner's third proposal.
  *Brevity bias*: summarizing drops the domain detail that made the insight useful.
  *Context collapse*: repeated whole-text rewriting erodes detail over iterations. Its
  remedy is to represent the accumulated context as a list of itemized entries updated
  incrementally rather than as one block of text rewritten each cycle, with reported
  gains of 10.6 percent on agent tasks and 8.6 percent on finance. Supported.

That last item is the most directly actionable finding in this section. The owner's
design — one string, rewritten daily — is the exact configuration ACE identifies as
failing. The established alternative is an itemized list with add, update, and delete
operations and per-item provenance. Adopting the itemized form is a low-risk design
choice with published support, and does not require its own experiment to prefer over
the monolithic form; it requires an experiment only to prefer it over having no
long-lived prompt at all.

### 6.3 Hallucinated detail: measurable countermeasures

The owner correctly identified this failure mode from experience. It is also the most
studied failure mode in this section, so the countermeasures are concrete.

- **Claim decomposition plus verification.** FActScore (arXiv 2305.14251, EMNLP 2023)
  breaks a generation into atomic facts and scores the fraction supported by a source,
  and reports that an automated estimator tracks human judgment within about 2 percent
  error. AlignScore (ACL 2023) and SummaC score factual consistency by chunk-level and
  sentence-level entailment against the source. Supported.
- **Mandatory citation with rejection.** `memory-extension.md` §14.1 already requires
  every factual summary statement to carry source record or valid Block citations, to
  label unsupported synthesis as inference, and to fail validation when citations are
  missing or invalid. The measurable addition is a threshold: reject any summary
  sentence whose entailment score against its cited sources falls below a value frozen
  on development data. This turns the existing rule from a formatting requirement into
  a filter with a measured error rate.
- **Verify skills by re-execution, not by self-report.** Following Voyager, a distilled
  skill is accepted only if replaying a recorded task with the skill available produces
  a validator pass at least as often as without it. A model asserting that its own
  skill is good is not evidence; `protocol.md` already states that receiving a response
  is availability, not task success.

### 6.4 Falsifiable hypotheses

- **H4-A**: citation-constrained summarization with an entailment filter reduces the
  unsupported-claim rate relative to unconstrained summarization by at least half, at
  no more than a declared cost increase.
- **H4-B**: distilled skills improve task success on held-out tasks relative to no
  skills, under equal token budget.
- **H4-C**: an itemized incrementally-updated long-lived prompt outperforms both no
  long-lived prompt and a monolithic daily-rewritten prompt, and does not degrade over
  successive cycles.
- **H4-D**: summaries written in one grammatical person cause fewer later
  misattributions — the agent asserting a summarized third-party statement as its own
  experience — than the other. This is the owner's question about person, and no
  literature was found on it. Hypothesis. It is answerable with an attribution probe
  set: questions whose correct answer requires knowing who said or did something.

### 6.5 Baseline, metrics, minimum effect

Baselines: no summary; verbatim recent window only; unconstrained summary with no
citation requirement.

Metrics: unsupported-claim rate per 100 summary sentences, by an entailment checker
with a human-audited sample as required by `protocol.md`; downstream task accuracy;
false-memory use rate; degradation across cycles, measured by re-running cycle 1
tasks after cycle N; token and call cost per cycle; and prompt length growth, since an
unbounded accumulating prompt is a cost regression even when it is accurate.

Minimum useful effect: H4-A halves the unsupported-claim rate. H4-B and H4-C each give
5 percentage points absolute task accuracy with a paired confidence interval excluding
zero. A drift check is mandatory for H4-C: accuracy on cycle-1 tasks must not fall by
more than 2 points after N cycles, which is the operational test for context collapse.

### 6.6 Data, cost, failure criteria, negative outcome

Data must be split so that the sessions used to distill skills never appear in the
held-out evaluation. This is easy to violate accidentally and it is the most likely way
this experiment produces a false positive.

Cost is the highest of the memory experiments because each cycle is a generation over a
day of Blocks, and the drift check requires N cycles. Bound N explicitly, for example
N = 10, before starting.

Reject if the unsupported-claim rate after filtering is not meaningfully below the
unfiltered baseline, if skills do not beat no-skills under equal budget, or if the
long-lived prompt degrades cycle-1 accuracy beyond tolerance.

If the result is negative, the fallback is: keep the daily summary as an inspectable
stored artifact with citations that is never injected automatically, and keep skills
as Skill-extension premise text, which is what `docs/spec/skill-extension.md` already
does. A summary that a human can read is useful even if injecting it is not.

**Gating verdict**: experiment required before any summary output is injected
automatically or promoted into a system prompt. `memory-extension.md` §14.1 already
forbids the latter, and that prohibition should be kept regardless of results, because
a summary is generated content and stays inside the untrusted-recalled-content
boundary of §13.1.

## 7. Question 5: architecture comparison

### 7.1 Precise statement

Two configurations. **Direct**: one main language-model Module consumes all external
input Pages and holds all tools including the Model Context Protocol servers and
Memory. **Mediated**: the main Module connects only to weaker language-model Modules;
those hold the tools and query Memory, and the main Module reaches Memory only through
them. A third question is whether role division emerges without being assigned, in
comparison with roles assigned by hand.

### 7.2 What is already known

- **Orchestrator plus subagents can win, at large token cost.** Anthropic's published
  engineering account of its multi-agent research system reports a lead agent spawning
  parallel subagents with separate context windows, outperforming a single-agent
  configuration by 90.2 percent on an internal research evaluation, while using roughly
  15 times the tokens of ordinary chat. Supported as an industrial report; note it is
  an internal evaluation, and note that the token multiple means the comparison was not
  budget-matched.
- **Multi-agent systems fail for structural reasons.** "Why Do Multi-Agent LLM Systems
  Fail?" (arXiv 2503.13657, NeurIPS 2025) analyzes traces across seven frameworks and
  defines 14 failure modes in three categories: system design, inter-agent
  misalignment, and task verification, with inter-annotator agreement κ = 0.88.
  Supported.

These two results together generate the prediction this experiment should be built to
test. `protocol.md` Gate 5 requires equal model, tool, token, time, and information
budgets wherever those are not the subject of the hypothesis. Under that constraint,
the mediated configuration loses the parallel-breadth advantage that made Anthropic's
system win, while keeping the coordination and specification costs that MAST catalogs.
The expected outcome is therefore that mediation loses on latency and on
tightly-coupled tasks, and may win only on tasks that decompose into independent
parallel searches. Stating that prediction in advance is what makes the run
informative.

MAST's finding that specification and coordination problems dominate also predicts the
answer to the emergent-role question: unassigned roles should do worse than assigned
roles, because unassigned roles are specification ambiguity by construction.

### 7.3 Falsifiable hypotheses

- **H5-A**: at equal total token budget, the mediated configuration achieves higher
  task success than the direct configuration.
- **H5-B**: mediation reduces context contamination failures, measured as tool output
  crowding out task-relevant content, even where it does not improve success.
- **H5-C**: assigned roles beat emergent roles at equal budget. Expected to hold.
- **H5-D**: mediation's relative advantage increases with task parallelism, tested by
  splitting the task set into independently-decomposable and tightly-coupled subsets
  declared before the run.

H5-D is the hypothesis most likely to produce a usable design rule, because it
predicts *when* to use which topology rather than declaring a winner.

### 7.4 Experiment design

- **Controlled variables**: same base model for the main Module in both arms, same tool
  set reachable in total, same total token budget, same wall-clock limit, same
  information available, same random seeds where seeds exist, same Memory corpus.
- **Manipulated variable**: topology only, in the first comparison. If the weak model
  differs from the main model, that is a second manipulated variable and needs its own
  arm; do not confound topology with model choice.
- **Pairing**: each task runs in both arms with randomized order and fully isolated
  state between runs. Report per-case deltas.
- **Sample size**: for a paired binary outcome, the required number of task instances
  is approximately `n ≈ (z_{α/2} + z_β)² · p_d / δ²`, where `p_d` is the discordance
  rate — the fraction of tasks where the two arms disagree — and `δ` is the absolute
  effect to detect. With `p_d = 0.30` and `δ = 0.10` at 80 percent power and
  α = 0.05, `n ≈ 7.85 × 0.30 / 0.01 ≈ 236` paired tasks. Estimate `p_d` from a pilot
  of 30 to 50 tasks rather than assuming it; if discordance is higher, `n` grows
  proportionally. Follow "Adding Error Bars to Evals" (arXiv 2411.00640): analyze
  paired differences, use power analysis to fix the count in advance, take multiple
  samples per question to reduce scoring noise, and use clustered standard errors when
  tasks share structure, since clustered errors can be more than three times the naive
  ones.
- **Validators**: deterministic task-state validators wherever the task permits.
  Model judging only where unavoidable, with a versioned rubric, blinded condition
  labels, repeated judging, and a human-audited sample, per `protocol.md`.

### 7.5 Metrics

Task success rate is primary. Also required: total tokens, total provider calls,
wall-clock time to completion, failure classification by MAST category so failures are
comparable across arms, and information loss at the mediation boundary, measured as
the rate at which a fact present in a tool result never reaches the main Module.

That last metric is the mechanism-level measurement that explains any success-rate
difference, and it is worth more than the success rate alone.

### 7.6 Competitor comparison and public benchmarks

For comparison against OpenClaw, Hermes, or any other assistant, use public benchmarks
rather than internal task sets, and report harness details.

- **GAIA** for general assistant tasks requiring tools and multi-step reasoning.
- **SWE-bench Verified** for software engineering.
- **WebArena** for browser tasks; self-hosted, which is good for reproducibility.
- **OSWorld** for computer use, which connects to `docs/experiments/computer-use-protocol.md`.
- **τ²-bench** for multi-turn tool use with policy adherence.
- **LongMemEval** and **LoCoMo** for the memory claims specifically.

Three cautions, all Supported by the protocol already in force. A benchmark score
measures the whole system, not the architecture, so a competitor comparison cannot
settle H5-A. Harness differences — tool set, retry policy, time limit, scaffolding —
routinely move these scores more than model differences, so publishing Dolly's harness
configuration is mandatory for the number to mean anything. And several leaderboards
mix reported and independently reproduced numbers; only self-run results with a
retained manifest should be treated as evidence.

### 7.7 Failure criteria and negative outcome

Reject the mediated topology as a default if H5-A fails at equal budget and H5-D shows
no parallelism-dependent advantage. Reject emergent role division if H5-C holds, which
is expected.

A negative result here is useful and should be published internally as such: it means
Dolly should default to the direct topology and treat mediation as a per-configuration
choice for parallel research-style tasks. Since topology in Dolly is configuration —
Pages and Module connections in the instance configuration file — neither outcome
requires architectural rework. That is a genuine advantage of the current design and
it means this question is not implementation-blocking.

**Gating verdict**: not implementation-blocking. Both topologies are expressible in
the existing configuration contract. The experiment decides a recommended default and
documentation, not code structure. It should run last, because it is the most
expensive and because it depends on Memory and scheduling being stable.

## 8. Implementation gating summary

Must have an experiment result before any default behavior:

- AIMD control of internal Module activation frequency (§3).
- Any use of tensity to select what is removed from a context (§4).
- Trajectory or sequence-shape matching (§5.3).
- Part-of-speech ablation before embedding (§5.3).
- Emotion or intensity features in retrieval scoring (§5.4).
- Automatic injection of daily summaries or distilled skills (§6).
- Promotion of any generated text into a system prompt (§6, and forbidden by
  `memory-extension.md` §14.1 independently of results).

May be implemented now with a conservative baseline and optimized later:

- Fixed scheduling per `core-runtime.md` §13.3, plus a watermark policy derived from
  the per-consumer pending state already in §13.2 (§3.5).
- Append-only compaction with a protected recent window and whole-unit removal (§4.7).
- Hybrid lexical and vector retrieval with a named fusion, per `memory-extension.md`
  §10.2 (§5.2).
- Daily summary as a stored, citation-carrying artifact that is never auto-injected
  (§6.6).
- Skills as Skill-extension premise text, per `docs/spec/skill-extension.md` (§6.6).
- Both architecture topologies as instance configuration (§7.7).

Not implementation-blocking at all:

- The architecture comparison (§7). It selects a documented default, not a design.

## 9. Recommended priority order

Ordered by decisiveness per unit cost, and by what each result unblocks.

1. **Scheduler simulation (§3).** Deterministic, no model calls, no spend, and it
   settles a question that otherwise invites a hand-tuned controller into the runtime.
   It also produces the watermark baseline, which is worth having on its own.
2. **Tensity predictive-validity check (§4.6, H2-A).** Offline replay over recorded
   sessions. If tensity does not beat recency at predicting necessity, four downstream
   design questions disappear at once.
3. **Retrieval baseline (§5.6, H3-A).** Needed regardless of every research outcome,
   because `memory-extension.md` §17 requires the no-memory, lexical, vector, and
   hybrid comparison before any default profile. Do it because the product needs it.
4. **Context management comparison (§4.6, H2-B and H2-C).** First substantial live
   spend. Only run if H2-A survives.
5. **Summary faithfulness harness (§6.4, H4-A).** The entailment filter and its
   measured error rate are prerequisites for taking any other summary result
   seriously.
6. **Structural retrieval probe (§5.5, H3-B through H3-D).** Requires building the
   structural pair set, which is the real cost. Highest chance of a negative result.
7. **Skill distillation and long-lived prompt (§6.4, H4-B through H4-D).** Depends on
   item 5.
8. **Architecture comparison (§7).** Last. Most expensive, depends on the others being
   stable, and not implementation-blocking.

## 10. Sources

Scheduling and flow control:

- [FLINK-7282: Credit-based Network Flow Control](https://issues.apache.org/jira/browse/FLINK-7282)
- [A Deep-Dive into Flink's Network Stack](https://flink.apache.org/2019/06/05/a-deep-dive-into-flinks-network-stack/)
- [Reactive Streams Specification for the JVM](https://github.com/reactive-streams/reactive-streams-jvm)
- [Apache Storm 1.0.0 release notes: automatic backpressure](https://storm.apache.org/2016/04/12/storm100-released.html)
- [Apache Storm Performance Tuning: `topology.max.spout.pending`](https://storm.apache.org/releases/current/Performance.html)
- [Twitter Heron: Stream Processing at Scale (SIGMOD 2015)](https://sands.kaust.edu.sa/classes/CS390G/S17/papers/Heron.pdf)
- [Netflix/concurrency-limits](https://github.com/Netflix/concurrency-limits)
- [Netflix Technology Blog: Performance Under Load](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581)
- Chiu, D. and Jain, R., "Analysis of the Increase and Decrease Algorithms for
  Congestion Avoidance in Computer Networks", Computer Networks and ISDN Systems
  17(1), 1989.
  [Summary](http://www.flux.utah.edu/~kwright/paper_summs/network_papers/chiu_jain.increase_decrease_analysis.html)
- [Striking a balance between bufferbloat and TCP queue oscillation (APNIC)](https://blog.apnic.net/2018/03/19/striking-a-balance-between-bufferbloat-and-tcp-queue-oscillation/)

Context management and forgetting:

- [MemGPT: Towards LLMs as Operating Systems (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Generative Agents: Interactive Simulacra of Human Behavior (arXiv 2304.03442)](https://arxiv.org/abs/2304.03442)
- [MemoryBank: Enhancing LLMs with Long-Term Memory (arXiv 2305.10250)](https://arxiv.org/abs/2305.10250)
- [Performance Evaluation of the Random Replacement Policy for Networks of Caches (arXiv 1202.4880)](https://arxiv.org/pdf/1202.4880)
- [Caches: LRU versus random (Dan Luu)](https://danluu.com/2choices-eviction/)
- Cao, P. and Irani, S., "Cost-Aware WWW Proxy Caching Algorithms" (GreedyDual-Size),
  USENIX Symposium on Internet Technologies and Systems, 1997.
- [DeepSeek API: Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)

Retrieval:

- [Precise Zero-Shot Dense Retrieval without Relevance Labels, HyDE (arXiv 2212.10496)](https://arxiv.org/abs/2212.10496)
- [Drowning in Documents: Consequences of Scaling Reranker Inference (arXiv 2411.11767)](https://arxiv.org/pdf/2411.11767)
- [Turney, Similarity of Semantic Relations (arXiv cs/0608100)](https://arxiv.org/pdf/cs/0608100)
- [Turney, The Latent Relation Mapping Engine (arXiv 0812.4446)](https://arxiv.org/pdf/0812.4446)
- [What you can cram into a single vector: probing sentence embeddings (arXiv 1805.01070)](https://arxiv.org/pdf/1805.01070)
- [t2vec: Deep Representation Learning for Trajectory Similarity Computation (ICDE 2018)](https://github.com/boathit/t2vec)
- [How meaningful are similarities in deep trajectory representations?](https://www.researchgate.net/publication/336454027_How_meaningful_are_similarities_in_deep_trajectory_representations)
- [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents (arXiv 2502.06975)](https://arxiv.org/abs/2502.06975)
- [Mood state-dependent memory: a meta-analysis (Cognition and Emotion 3(2), 1989)](https://www.tandfonline.com/doi/abs/10.1080/02699938908408077)
- [Mood State-Dependent Retrieval: The Effects of Induced Mood on Memory Reconsidered](https://journals.sagepub.com/doi/10.1080/713755711)

Reflection, skills, and faithfulness:

- [Agent Workflow Memory (arXiv 2409.07429, ICML 2025)](https://arxiv.org/html/2409.07429)
- [Agentic Context Engineering (arXiv 2510.04618)](https://arxiv.org/abs/2510.04618)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models (arXiv 2305.16291)](https://arxiv.org/abs/2305.16291)
- [FActScore (arXiv 2305.14251, EMNLP 2023)](https://arxiv.org/abs/2305.14251)
- [AlignScore (ACL 2023)](https://github.com/yuh-zha/AlignScore)

Architecture comparison and evaluation:

- [Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657, NeurIPS 2025)](https://arxiv.org/abs/2503.13657)
- [How we built our multi-agent research system (Anthropic)](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [Adding Error Bars to Evals (arXiv 2411.00640)](https://arxiv.org/abs/2411.00640)
- [LongMemEval (arXiv 2410.10813, ICLR 2025)](https://arxiv.org/abs/2410.10813)
- [Evaluating Very Long-Term Conversational Memory of LLM Agents, LoCoMo (ACL 2024)](https://aclanthology.org/2024.acl-long.747/)
