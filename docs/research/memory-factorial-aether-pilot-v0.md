# Memory association and checkpoint Aether pilot

## Outcome

The completed owner-endpoint pilot provides exploratory evidence that repeated
position-aware association and a structured task checkpoint can complement one
another on the frozen positive interrupted-task cases. It does **not** justify
automatic task resumption or a product Memory default.

The registered all-or-nothing outcome classified the checkpoint main effect,
association main effect, and checkpoint-plus-association interaction as
pilot-supported. However, a case-level diagnostic found another representation
confound: all eight association-only outputs recovered the correct task,
idempotency key, retention value, decision, and required citations, but emitted
the action as `add_idempotency_guard` instead of the registered natural-language
string `add an idempotency guard`. Their registered success was therefore zero.
That diagnostic cannot change the frozen score. It does prevent attributing the
observed gain to better task knowledge or retrieval alone.

The next engineering choice is consequently conservative: keep association
evidence and source-cited task checkpoints as separate experimental mechanisms;
do not make either a product default until a new negative-cue, multi-task-family
confirmation uses a closed action enum and source entailment rather than exact
surface wording or redundant-citation count.

## Frozen run

- run ID: `aether-v1-20260812a`
- source commit: `e94a183e4845f29dfe79aef91c787653a9cfa0f8`
- preregistration SHA-256:
  `f5e5cfa0ef3e847e4725f9b8df6409af573e17fbb3f877461f5e94f9fd5cef27`
- protocol SHA-256:
  `07eeafeee9bd965b0c58219742303d26cdf612022e9b9909c2f5e280bed96c8d`
- started: `2026-08-12T12:15:50.827Z`
- finished: `2026-08-12T12:48:29.132Z`
- backend: owner Aether `qwen3.6-27b`, reported only as a separate optional
  deployment fixture
- logical model calls: 64
- request attempts: 64
- generated-checkpoint calls: 16
- Agent calls: 48
- transport retries, terminal infrastructure failures, malformed responses,
  invalid citations, and unrelated-record use: zero

All successful requests used strict SSE with `stream: true`, one terminal usage
event, and one `[DONE]`. There was no non-stream fallback. The owner raised the
nginx gateway timeout from 120 seconds to 24 hours before this run. Several
thinking-enabled checkpoint calls exceeded the old gateway boundary and still
completed successfully; none was canceled by the gateway.

The checkpoint constructor used `thinking.type: "enabled"`; 16/16 responses had
nonempty `reasoning_content`, ranging from 4,425 to 9,272 characters. The Agent
used `thinking.type: "disabled"`; 0/48 responses had nonempty
`reasoning_content`. This is response evidence for these calls, not an inference
from accepted request parameters.

## Registered results

Association here means a deterministic expansion through term pairs observed
near one another in at least two distinct episodes. It is not causal inference.
A task checkpoint means a bounded structured record of task identity, completed
step, canonical action, arguments, constraints, status, and raw source record
identifiers.

| Condition | Grounded resume | Cases | Evidence bytes, range |
| --- | ---: | ---: | ---: |
| content, no checkpoint | 0.000 | 8 | 941–950 |
| association, no checkpoint | 0.000 | 8 | 980–985 |
| content + extractive checkpoint | 0.000 | 8 | 1,411–1,425 |
| association + extractive checkpoint | 0.375 | 8 | 1,511–1,521 |
| content + generated checkpoint | 0.000 | 8 | 1,395–1,419 |
| association + generated checkpoint | 0.750 | 8 | 1,498–1,612 |

Registered factorial effects:

- checkpoint main effect: `+0.28125`;
- association main effect: `+0.375`;
- checkpoint-association interaction: `+0.5625`;
- extractive minus generated checkpoint marginal success: `-0.1875`.

The first three exceeded the preregistered `0.125` exploratory thresholds. The
extractive representation failed its preregistered non-inferiority margin of
`-0.125`.

These effects are small-sample paired proportions. The pilot deliberately does
not use them to claim public-model reproducibility, negative-cue safety,
obsolete-memory safety, held-out task-family generality, or product support.

## Case-level falsification

The aggregate result alone overstates what was learned.

1. Content retrieval recovered the current task record but not the historical
   retention constraint in all eight scenarios. Association recovered the
   current task and both repeated historical constraint records in all eight.
   This is a real retrieval difference.
2. Every association-only Agent output returned the correct resume decision,
   task ID, idempotency key, retention value, and all three required source
   citations. All eight used the action enum-like value
   `add_idempotency_guard`; the frozen score required the natural-language
   string. Thus their 0/8 score is a representation failure, not a task-recovery
   or evidence failure.
3. Association plus extractive checkpoint returned all exact action fields in
   8/8, but only 3/8 outputs cited both semantically redundant retention source
   records. The other five cited the current task record and one supporting
   retention record, producing 3/8 registered success.
4. Association plus generated checkpoint returned the exact task fields and
   all required citations in 6/8. The two failures used a wrong task identifier
   even though their cited raw evidence was complete.
5. The extractive checkpoint itself had all six exact fields in all 8
   association-on scenarios and correctly left unsupported retention null in
   all 8 content-only scenarios. Only 1/16 generated checkpoints had all six
   exact fields. Generated checkpoints often normalized status or completed-step
   text differently, and two association-on generated checkpoints changed the
   task identifier.

Consequently, the registered downstream non-inferiority result does not show
that generated checkpoints are more faithful than extractive checkpoints. The
generated condition's better Agent score mostly reflects the Agent's output and
citation behavior when it received both raw association evidence and a derived
representation. The checkpoint field metric points in the opposite direction.

## Independent validation

The independent verifier does not import the treatment implementation. It
recomputed dataset truth from source roles and text, independently rebuilt
content and association evidence, checked model-prompt evidence, recomputed all
checkpoint and Agent fields and factorial effects, verified retry and strict SSE
contracts, checked relevant source and artifact hashes, and scanned for the
configured endpoint and credential values.

- validation: valid;
- dataset/checkpoint/case/logical-call coverage: `8/32/48/64`;
- strict-stream coverage: `1.0`;
- invalid citations, unrelated-record use, malformed outputs, terminal
  infrastructure failures: zero;
- five registered mutation classes rejected: `5/5`.

Important artifact digests after validation:

- `analysis.json`:
  `9301d3a1661fe8aa4e246c11d228eeb24b0acec9600a8360fa6d5939aa2720e4`
- `validation.json`:
  `3e04faa381656fac9162b333011e0584d218ceb85a92c61bfbed4ad82f2020ce`
- `model-raw.jsonl`:
  `456b3fa2c56d89e56cabcd7d2d8b8f25136f6624baa8427f89ef0dcb169dc0c1`
- mutation summary:
  `6027fef1b0c851d9c3ac92410e529a45dc4a9d40e3ce27118a73ac0425457c1c`

The local ignored artifacts are retained at:

- `artifacts/experiments/probes/memory-factorial-aether-pilot-v0/runs/aether-v1-20260812a/`
- `artifacts/experiments/probes/memory-factorial-aether-pilot-v0/verification-mutations/aether-v1-20260812a/`

## Decisions and next experiment

This pilot changes the next experiment, not the product runtime.

1. Replace free-form `action` scoring with a closed operation enum plus a
   separately validated argument object. Surface spelling and prose must not
   decide task recovery.
2. Score source grounding by whether cited eligible sources entail every field.
   Do not require citing both duplicate records when either independently
   supports the same constraint; report duplicate corroboration separately.
3. Cross positive resume with `do-not-resume`, canceled, and superseded cues;
   association must not reactivate obsolete work.
4. Use disjoint task families and multiple interruption lengths. This pilot's
   eight cases vary values but share one task template.
5. Compare raw association evidence, deterministic extractive checkpoint, and
   the combination. Retain a generated checkpoint arm only as a separate
   candidate: it is more expensive and was less field-faithful here.
6. Require a public, revision-pinned backend before any architecture promotion.
   Owner Aether remains an optional deployment fixture and cannot be the sole
   dependency or proof.
7. A later reversible product slice may store an explicit source-cited task
   checkpoint, but it must remain derived, unprivileged, separately deletable,
   and disabled for automatic resume until the negative-cue confirmation passes.

The Dolly Module startup refusal remained unchanged throughout the experiment;
the probe did not launch the product Module runtime.
