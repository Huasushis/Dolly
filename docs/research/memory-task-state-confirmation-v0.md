# Memory task-state confirmation experiment

## Decision summary

This private-endpoint experiment does not support automatic task resumption, a task-checkpoint default, or a general associative-memory implementation. It does support a narrower engineering direction: raw associated records carried enough information for the Agent to return the correct task decision, state, operation, arguments, and constraint in all 16 scenarios, but the current evidence-attribution interface was too brittle to pass the preregistered gate.

The completed run used 64 isolated Agent calls: 16 task-state scenarios crossed with content retrieval, association retrieval, a deterministic source-cited task checkpoint, and the same checkpoint plus association records. A task checkpoint means a bounded structured record of the current task state, next operation, durable constraint, and source-record identifiers. Every call used strict server-sent event (SSE) streaming on the owner's Aether/qwen3.6-27b deployment.

The frozen decisions are:

- reject association retrieval as an implementation choice from this run alone;
- reject the current checkpoint representation;
- reject checkpoint-plus-raw composition;
- keep automatic resumption disabled.

These rejections are retained even where a post-run diagnostic shows correct task behavior. The diagnostic changes the next experiment, not this run's score.

## Registered question and conditions

The experiment asks whether an Agent can recover an interrupted task while respecting later cancellation, supersession, and an explicit instruction not to resume. It crosses two task families, two task identities per family, and four task states:

- positive resume;
- explicit do-not-resume;
- cancellation after the old operation;
- a newer operation superseding the old operation.

The four evidence conditions are:

1. `content-raw`: current-operation and update records selected by content only;
2. `association-raw`: the same records plus two historical constraint records selected as associated evidence;
3. `checkpoint-only`: one deterministic structured checkpoint derived only from the association packet;
4. `checkpoint-association`: byte-identical checkpoint plus byte-identical association records.

The Agent output has a closed operation enum, exact arguments, a decision and state, and separate citations for state, action, and constraint claims. Checkpoint citations were required to name the underlying raw source identifiers rather than the derived checkpoint identifier. This rule was deliberate: the experiment tests traceable evidence, not only whether a checkpoint contains the answer.

## Endpoint and streaming evidence

The owner had raised the nginx gateway timeout from 120 seconds to 24 hours before this run. The experiment retained its independent 900-second per-call deadline and four-hour total wall-clock budget.

All 64 calls used:

- `stream: true`;
- `stream_options.include_usage: true`;
- `thinking.type: "disabled"`;
- no `enable_thinking` field;
- `temperature: 0` and `max_tokens: 1200`;
- strict `text/event-stream` parsing with bounded bytes, buffer size, events, and output;
- exactly one terminal usage event and one `[DONE]` marker;
- no non-stream fallback.

Several responses took longer than the old gateway limit and completed normally on the same stream. The run completed 64 logical calls in 64 attempts, so there were no transport retries. All 64 successful responses ended with `finish_reason: "stop"`; none contained non-empty `reasoning_content`. Aggregate usage was 52,233 prompt tokens and 11,212 completion tokens.

This proves the measured request profile for this fixture. It does not establish availability or cost behavior on another endpoint.

## Results

| Condition | Strict semantic success | Action-bearing success | False resume | Obsolete action use | Invalid citations |
|---|---:|---:|---:|---:|---:|
| content raw | 4/16 | 0/8 | 0 | 0 | 4 |
| association raw | 11/16 | 7/8 | 0 | 0 | 5 |
| checkpoint only | 4/16 | 0/8 | 0 | 0 | 22 |
| checkpoint + association | 6/16 | 2/8 | 0 | 0 | 12 |

The strict result rejects all three candidate Memory mechanisms. Association retrieval required 8/8 action-bearing successes, at least two paired improvements over content retrieval, no paired loss, and no invalid citation. It reached 7/8 and had five invalid citations. The checkpoint lost seven cases relative to association retrieval. The composition rescued no case missed by both components and lost five action-bearing cases relative to the better component.

Checkpoint evidence was smaller: median/p95 evidence bytes were 692/728 versus association retrieval's 1,295/1,661. Compression therefore passed, but the representation did not preserve behavior.

### Functional task behavior

The per-field diagnostic is materially different from the all-or-nothing score:

- association retrieval produced the correct decision, decision reason, task identifier, task state, operation, arguments, and constraint in 16/16 cases;
- all four association do-not-resume cases correctly abstained, but cited the old current-operation record for a state claim that the frozen truth intentionally treated as needing no memory evidence;
- one association supersession case returned the correct replacement operation but cited the old operation record, rather than the supersession record, for current state;
- no condition ever resumed a cancelled or explicitly paused task, and no condition executed the obsolete operation.

Thus raw association records are functionally promising on this synthetic packet, but the experiment does not isolate an association algorithm: packets were generated deterministically from known record roles. The result cannot justify building an association index yet.

### Checkpoint failure modes

The simple checkpoint representation failed in two distinct ways:

1. The Agent frequently cited the visible checkpoint identifier instead of the checkpoint's underlying `sourceRecordIds`. That is a real mismatch with the registered provenance contract, not a parser artifact.
2. Three of four checkpoint-only supersession cases interpreted `state: "superseded"` as a reason to abstain with cancelled state, even though the checkpoint also contained the current replacement operation.

Checkpoint-plus-association did not repair these problems. It often mixed a checkpoint identifier into one claim and raw identifiers into another, increasing citation errors without producing a unique functional rescue.

The current checkpoint should therefore not be integrated. A next version should represent the task as `state: "active"` plus an explicit revision relation such as `replaces`, rather than using `superseded` as the state itself. Evidence handles should be Host-issued, machine-checkable references. If a derived checkpoint handle is allowed, the Host must deterministically resolve it through frozen one-hop provenance; the model should not be expected to copy long raw identifiers merely to prove that mapping.

### Content baseline

Content retrieval correctly abstained for cancellations and do-not-resume cues. It lacked the historical constraint for positive cases. All four supersession responses returned the correct replacement operation name but used a string where the closed contract required an object containing operation and arguments, so they were retained as HTTP-200 content/schema failures and were not retried.

## Evidence quality

The independent verifier reconstructed all 16 scenarios, all 64 evidence packets, all model messages, every score, aggregate decisions, request/retry rules, source hashes, artifact hashes, and configured-secret leakage checks without importing the treatment implementation. It reported:

- 16/16 dataset rows and 64/64 case rows;
- 64 logical calls and 64 retained attempts;
- strict-stream coverage 1.0;
- zero reasoning-profile deviations and zero infrastructure failures;
- valid source and artifact hashes;
- no configured endpoint or credential value in checked artifacts.

Eight mutation copies were all rejected: a missing case, `stream:false`, a forbidden `enable_thinking`, an illegal retry after HTTP-200 content failure, swapped scenario output, forged citation metrics, a removed artifact digest, and an injected configured secret.

Before the paid run, a zero-network synthetic contract self-test exposed two harness defects. The first attempt could not create a missing artifact parent; the second reconstructed sufficient source sets but omitted their `claimId`. Both failed before any paid confirmation result, were fixed in separate pushed commits, and the failed synthetic run was retained. The succeeding synthetic run passed 64/64 reconstruction and 8/8 mutations. This self-test proves verifier wiring, not model efficacy.

## Engineering decision

The next reversible Memory work should separate three questions that this run still mixes:

1. retrieval: can a real content/recurrence/position algorithm choose the right bounded raw records without oracle roles;
2. task representation: can a normalized active task revision preserve cancellation and replacement semantics;
3. provenance: can Host-issued evidence handles and deterministic one-hop provenance validate support without asking the model to reproduce storage identifiers.

Until those are tested:

- retain the existing small, explicit task-checkpoint storage only as a bounded mechanism demo;
- do not inject checkpoints automatically;
- do not implement the current checkpoint schema as a default Memory format;
- do not add checkpoint-plus-raw composition;
- require explicit recall or user confirmation before resuming;
- keep the public Module startup refusal unchanged.

The next confirmation should use a versioned protocol rather than rescore this run. It should keep the same negative task states, add an actual retrieval treatment and sham control, score functional correctness separately from provenance validity while requiring both for promotion, and repeat each condition across decoder seeds or a public revision-pinned backend before any product default.

## Frozen evidence

- source commit: `242b27193685d9c041fb76cbaf9016bb672851c3`
- preregistration SHA-256: `6b955e63c733613aa70cedfc4f88602ff6a29301a05301a008bac300d31a11e4`
- protocol SHA-256: `5723b439c0923c5d6f06575f99bace0869b590ec6d6e561e669215bc6c140956`
- dataset SHA-256: `78c34382fe3644d572380add40eaeec4feb4c08c3bb7970f331abf4aaf0aeb27`
- cases SHA-256: `11b646137ac4784518a4b2c494dd0c33d3217c589f7806fae4a676e4b295840b`
- model raw SHA-256: `042c8878854879f3a706eae120ac48706ca4bfa99d5332b140e420e93ba2361b`
- analysis SHA-256: `454f3e2ea8e978d0994212fb988068789d4277fbb4d43e9a3291770dc07f9a10`
- validation SHA-256: `966d810463a144c189674658030515a46c74b810d6996978bc0339b48b6a943b`
- mutation summary SHA-256: `f1fbbb330e757e8824c9e184f8d7a7d04fe1f34a07f31cc1207269df34046808`

The raw run and mutation copies are retained under ignored local artifact paths:

- `artifacts/experiments/probes/memory-task-state-confirmation-v0/runs/aether-v1-20260812a/`
- `artifacts/experiments/probes/memory-task-state-confirmation-v0/verification-mutations/aether-v1-20260812a/`
- synthetic lineage under the same roots with run IDs `aether-v1-synthetic-20260812a` and `aether-v1-synthetic-20260812b`.

The owner endpoint and credential are not recorded in these artifacts.
