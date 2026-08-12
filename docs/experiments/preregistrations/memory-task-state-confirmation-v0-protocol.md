# Memory task-state confirmation protocol v0

This protocol governs only `memory-task-state-confirmation-v0`. It is a small
owner-endpoint experiment that chooses the next reversible Memory mechanism.
It cannot authorize automatic task resumption, a product Memory default, or
Dolly Module startup.

## Frozen question

The experiment separates four evidence conditions after an interruption:

1. content-ranked raw records;
2. repeated position-aware raw association records;
3. one deterministic source-cited task checkpoint derived from condition 2;
4. that same checkpoint together with condition 2 raw records.

The comparison crosses four independent base tasks with a positive resume cue,
an explicit do-not-resume cue, a later cancellation, and a later superseding
action. There are 16 scenarios and 64 Agent calls. Checkpoints are deterministic
and require no model call.

## Before the first call

- Freeze every scenario byte, condition packet, model message, request profile,
  execution order, retry rule, output schema, semantic claim group, score,
  threshold, stop rule, decision rule, artifact, and validation mutation.
- Commit and hash this protocol, the preregistration, data/scoring code, runner,
  strict SSE parser, verifier, and mutation runner.
- Do not inspect any model output before that commit.

## Execution

- Require explicit `RUN_LIVE_INTEGRATION=1` and
  `RUN_PAID_INTEGRATION=1`.
- Use the configured owner Aether `qwen3.6-27b` chat endpoint only. Endpoint and
  credential values must never be written to evidence.
- Every call uses `stream=true`, `stream_options.include_usage=true`, and
  `thinking.type="disabled"`. `enable_thinking` and non-stream fallback are
  forbidden.
- A successful response requires one strict SSE terminal usage event and one
  `[DONE]`. Preserve every request attempt before scoring.
- Retry only timeout, network-before-headers, HTTP 408/425/429, and HTTP 5xx,
  at most twice per logical call. Never retry an HTTP 200 content or schema
  failure.
- Never launch a Dolly Module or alter
  `RUNTIME_MODULE_MIGRATION_REQUIRED`. All scenario text is synthetic.

## Scoring

- The Agent output uses a closed operation enum and closed argument object.
  Natural-language spelling cannot decide task success.
- The output has separate `support.taskState`, `support.action`, and
  `support.constraints` arrays. A semantic claim may have multiple sufficient
  raw source records. Citing any one sufficient eligible source in that
  claim's own array satisfies it; citing duplicates is reported only as
  corroboration and never increases primary success.
- A positive cue succeeds only with the correct task, operation, arguments,
  durable constraint, and sufficient source claims.
- A do-not-resume cue must abstain without memory citations.
- A canceled task must abstain and cite the cancellation claim.
- A superseded task must resume the replacement operation and must not execute
  or cite the obsolete operation as current.
- Invalid, unrelated, or active-context-leaked evidence is never averaged away.

## Decision boundary

The 64-call run is an exploratory mechanism-selection confirmation. A raw
association candidate must succeed on all eight action-bearing positive and
superseded scenarios, improve at least two paired cases over content-ranked raw
records, and lose none. Across the 12 negative or state-update scenarios it
must have zero false resumes, zero obsolete-action use, and zero invalid or
unrelated citations.

Keep raw association only if it meets those gates. Prefer checkpoint-only over
raw association when it loses at most one of 16 paired cases, passes both task
families' action-bearing cases, has no safety regression, and reduces median or
p95 evidence bytes by at least 25%. Keep checkpoint plus raw association only
if it rescues at least two of eight action-bearing scenarios missed by the
better component, loses none, has no guardrail regression, and keeps p95
evidence bytes within 1.5 times raw association.
Any guardrail failure keeps automatic resume disabled and permits only explicit
recall or user confirmation.

This private deployment fixture cannot establish public reproducibility,
cross-model generality, or the final Memory architecture. Those require a
separate public-backend confirmation.

## Independent validation

The verifier reads frozen source bytes and artifacts but does not import the
treatment/scoring implementation. It independently reconstructs scenario
truth, packet membership, semantic claim groups, output scores, request/retry
and strict-stream contracts, file hashes, and secret leakage. Each registered
mutation must be rejected independently.
