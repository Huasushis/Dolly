# Memory association and interrupted-task recovery experiment

## Decision summary

The completed live pilot supports an explicit learned task checkpoint as a candidate mechanism for interrupted-task recovery. It does **not** yet support a general Memory design, automatic task switching in Dolly, or repeated position-aware association as a product default.

The preregistered version-11 run completed 1,908 case rows: 1,872 deterministic mechanism rows and 36 live Agent rows. All generation calls used strict server-sent event (SSE) streaming with no non-stream fallback. The 38 logical Aether calls required 40 request attempts. The independent artifact verifier passed. The earlier version-9 mutation campaign remains the current verifier-mutation evidence; it is not silently attributed to version 11.

The strict primary metric passed:

- after-learning combined memory versus normalized content: `+1.00` absolute on both pilot seeds;
- combined memory after versus before learning: `+1.00` absolute on both seeds;
- unrelated-record use: `0.00` for both combined memory and normalized content;
- active-context leakage: `0`;
- deterministic repeat agreement: `1.00`.

This is only a two-seed synthetic pilot. The result selects the next experiment; it does not authorize product behavior.

## What was tested

Each synthetic case records an invoice-import task, interrupts it with an unrelated certificate task, clears the original records from active context, and then supplies a natural-language resume cue. Ground-truth record roles and identifiers are fixed before retrieval or a model call.

The deterministic study crosses 24 seeds, before/after learning, 13 conditions, and three repeats. The live pilot uses two evaluation seeds, nine paired conditions, one learned representation construction call per seed, and one Agent call per condition and phase.

The learned representations are a task checkpoint, extractive summary, reusable procedure, and durable fact. Repeated position-aware association counts support across distinct episodes and uses proximity only as association evidence; it is not called causal inference.

The live endpoint profile reflects observed Aether/qwen3.6-27b behavior:

- learner: `thinking.type=enabled`, 5,200 completion tokens, 180-second timeout;
- scored Agent: `thinking.type=disabled`, 800 completion tokens, 90-second timeout;
- both generation roles: `stream=true`, `stream_options.include_usage=true`, strict `text/event-stream`, one usage event, one `[DONE]`, and no non-stream fallback;
- no `enable_thinking` field;
- no local model, DashScope, object storage, Dolly runtime, or Module launch path;
- a response proves reasoning only when `reasoning_content` is non-empty.

All scored treatment and baseline Agent calls use the same disabled-thinking profile. Therefore this run says nothing about reasoning-enabled Agent efficacy.

The owner's reverse proxy timeout was raised from 120 seconds to 24 hours before the completed version-11 run. The harness still applied its own per-call deadlines above. These are separate controls: the gateway no longer imposed the earlier short ceiling, while the experiment retained bounded stopping behavior.

## Frozen run lineage

Every stopped or interrupted run remains under the artifact root; none was overwritten or silently retried.

| Version/run | Persisted live attempts | Observed stop |
|---|---:|---|
| full-v2 | 1 | HTTP 200; 700-token non-empty reasoning; `finish_reason=length`; empty content |
| full-v3 | 1 | HTTP 200; 1,600-token non-empty reasoning; `finish_reason=length`; empty content |
| full-v4 | 1 | HTTP 200; 2,400-token non-empty reasoning; `finish_reason=length`; empty content |
| full-v5-a | 0 | server restart before a response row was persisted; whether the request reached Aether is unknown |
| full-v5-b | 1 | the previously undeclared 90-second harness timeout |
| full-v6 | 1 | HTTP 200; 3,600-token reasoning trace truncated inside a candidate JSON object; empty content |
| full-v7 | 7 | learner completed; one Agent exhausted 5,200 tokens; a later Agent timed out at 180 seconds |
| full-v8 | 5 | learner and three disabled-thinking Agents completed; the next Agent timed out at 90 seconds |
| full-v9 | 41 attempts for 38 logical calls | complete |
| full-v10 | 1 | HTTP 200 SSE; rejected because the first strict parser incorrectly required the usage event to have no choice entry |
| full-v11 | 40 attempts for 38 logical calls | complete; all 38 successful responses passed the corrected strict SSE contract |

Version 9 preregistered up to four attempts only for timeout, network/JSON transport failure, HTTP 408/425/429, or HTTP 5xx. HTTP 200 content failures were never retried. Two seed-302 learner attempts ended in `network-or-json` before attempt 3 succeeded; one disabled-thinking Agent attempt timed out before attempt 2 succeeded. All three failed attempts are retained.

Version 10 deliberately failed closed on the first HTTP 200 stream. The Aether usage event contained one choice with an empty delta, whereas the preregistered parser allowed only a choice-less usage event. Existing successful general-Agent stream evidence showed that the empty-delta form was the measured endpoint behavior. Version 11 therefore changed only that falsified wire-shape assumption: it accepts either zero choices or exactly one empty-delta choice on the unique usage event. It did not change the Memory data, conditions, seeds, metrics, or thresholds.

Version 11 retained the same bounded retry classes and never retried an HTTP 200 content or protocol failure. Logical Agent calls 2 and 21 each reached the 90-second harness deadline on attempt 1 and succeeded on attempt 2. Both timeout rows and all successful rows are retained.

## Results

### Deterministic mechanism study

All 1,872 rows were present. Three repeats of each identity agreed exactly, and no original-task record appeared in active context.

| Preregistered contrast | Absolute evidence-success gain |
|---|---:|
| repeated position-aware association vs normalized content | 1.00 |
| repeated position-aware association vs recurrence without position | 1.00 |
| repeated position-aware association vs shuffled position | 1.00 |
| repeated observations vs a single observation | 1.00 |

These values show that the implemented mechanism follows the synthetic construction. They are not generalization evidence: the generator and retrieval rule were designed around the same repeated-position factor.

### Live Agent pilot

All 36 Agent responses were parseable and had the required fields.

| Condition | Before-learning task-resume success | After-learning task-resume success | After-learning unrelated-record use |
|---|---:|---:|---:|
| no memory | 0.00 | 0.00 | 0.00 |
| exact lexical BM25 | 0.00 | 0.00 | 0.00 |
| sham replay | 0.00 | 0.00 | 0.00 |
| normalized content | 0.00 | 0.00 | 0.00 |
| repeated position-aware association | 0.00 | 0.00 | 0.00 |
| shuffled position | 0.00 | 0.00 | 1.00 |
| temporal neighbours | 0.00 | 0.00 | 0.00 |
| explicit task checkpoint | 0.00 | 1.00 | 0.00 |
| combined memory | 0.00 | 1.00 | 0.00 |

The combined condition and explicit checkpoint produced exact success for both seeds. Normalized content did not retrieve the historical retention constraint. Repeated position-aware association did retrieve the current checkpoint plus both historical constraints, and the Agent cited them and returned the correct task identifier, idempotency key, and retention duration for both seeds. It nevertheless failed the preregistered all-or-nothing metric because its natural-language `nextAction` included the key or reason while ground truth required the shorter canonical action. The learned checkpoint supplied the canonical field value.

That diagnostic is post hoc and cannot change the registered score. It exposes an important confound: the pilot mixes evidence retrieval with representation canonicalization. The observed `+1.00` primary gain cannot be attributed to position-aware association, summary, procedure, or durable fact. The explicit checkpoint alone already reaches the same score as the combined condition.

### Reasoning evidence and endpoint reliability

Only the two successful learner responses used enabled thinking. Both had non-empty `reasoning_content`, so those two calls have direct reasoning evidence. Disabled-thinking Agent calls correctly recorded empty reasoning. Across all 40 attempts, reasoning observation coverage was `1.00`; reasoning was non-empty on 2 attempts.

The complete version-11 run needed two timeout retries. This is evidence that a public adapter needs bounded, persisted, status-specific retries. It is not evidence that arbitrary model/content retries are safe.

All 38 successful version-11 responses were HTTP 200 `text/event-stream` streams with exactly one usage event, exactly one `[DONE]`, and an observed provider response identifier. The strict reader also required valid UTF-8, bounded bytes/events/buffer size, a stable provider identity, a terminal finish reason, and no data after `[DONE]`. Embedding calls are outside this generation experiment and are not converted to SSE.

## Independent validation

The independent verifier reads the frozen artifact snapshot and separately frozen implementation bytes; it does not import generation, retrieval, learning, or model-request functions. For version 11 it reported:

- valid artifact checksums;
- 1,908 total and 1,872 local rows;
- 40 retained request attempts covering 38 contiguous logical calls;
- valid attempt numbering and only preregistered retry causes;
- 38 successful strict streams, each with the required content type, one usage event, one `[DONE]`, and a provider identifier;
- deterministic repeat agreement `1.00`;
- active-context leakage maximum `0`;
- no configured endpoint or credential value in checked artifacts.

Five mutation copies were checked against version 9. Removing an expected constraint, inserting forbidden evidence, altering an aggregate, changing an unchecked JSONL byte, and contradicting the reasoning observation each caused the verifier to exit non-zero for the intended reason. The first mutation harness invocation is retained: restricted sandboxing denied its Node child-process launches with `EPERM`. The same prepared copies were then verified through five separate repository-scoped commands, recorded in `mutation-validation-v2.json`. Version 11 was independently validated, but its strict-stream-specific mutation matrix remains future work.

## Engineering decision

For the next simple Memory slice, prefer an explicit, source-cited task checkpoint with separate fields for task identity, completed step, canonical next action, idempotency key, durable constraints, and source record identifiers. Keep raw records and learned representations distinguishable. Do not promote the combined packet or position-aware association to a product default from this pilot.

The next preregistered experiment should:

1. factorially separate raw repeated-position evidence, an extractive checkpoint, a generated checkpoint, and checkpoint-plus-association;
2. preregister both exact field accuracy and a bounded semantic-action metric so representation formatting is not confused with retrieval;
3. use multiple task families, paraphrase families, negative cues, longer interruption gaps, and more than two evaluation seeds;
4. include a reproducible public or local backend while keeping the owner Aether deployment optional;
5. measure reasoning-enabled and disabled Agent profiles as separate endpoint conditions;
6. retain bounded evidence, exact source citations, transport-attempt logs, and deletion provenance.

Automatic task switching, persistence across restart, safe deletion, learned admission rules, Dolly runtime integration, and product-level Memory effectiveness remain unproven.

## Artifact locations

- preregistration: `docs/experiments/preregistrations/memory-association-task-switch-v0.json`
- harness and verifier: `scripts/experiments/probes/memory-association-task-switch-v0/`
- current complete strict-stream run: `artifacts/experiments/probes/memory-association-task-switch-v0/runs/full-v11-20260812a/`
- earlier complete non-stream run: `artifacts/experiments/probes/memory-association-task-switch-v0/runs/full-v9-20260809a/`
- failed and interrupted lineage: versioned run directories under `artifacts/experiments/probes/memory-association-task-switch-v0/runs/`, including the falsified `full-v10-20260812a/`
- mutation copies: `artifacts/experiments/probes/memory-association-task-switch-v0/verification-mutations/full-v9-20260809a/`
