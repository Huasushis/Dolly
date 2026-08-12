# Memory factorial v0 — deterministic representation confirmation (version 2)

This document explains the implemented version-2 design in
[`memory-factorial-v0.json`](../experiments/preregistrations/memory-factorial-v0.json).
It is a public, local, deterministic mechanism screen. It makes no network
request, downloads no model, uses no private data, and does not run Dolly or an
installed Module. No formal result directory has been produced.

The reference reader is deliberately simple: it proves that the generator,
representation, closed action schema, citation scorer, verifier, and mutations
agree on a falsifiable contract. It is not evidence that a language model or
Dolly can use the representation.

## Why version 2 is narrower than the earlier 2 × 3 plan

The earlier design crossed association off/on with no, extractive, and
generated checkpoints. That remains a useful future Agent study, but it was too
large to resolve the most immediate scoring ambiguity. The completed private
Aether pilot had two confounds:

- its raw-association answers named the right action semantically but used a
  different surface string, so exact string equality scored retrieval as a
  failure; and
- two historical records stated the same sufficient constraint, while the
  frozen score behaved as if both citations were jointly required.

Rescoring that pilot under closed operation/argument semantics and alternative
source-set semantics gives 8/8 for association raw and 8/8 for association plus
extractive checkpoint. Thus the old evidence does not show checkpoint benefit.
That is a diagnostic reinterpretation of the existing raw rows, not a new model
experiment and not product evidence.

Version 2 first makes those semantics executable. Generated checkpoints and
model effects are excluded because this task authorizes neither model downloads
nor owner/paid calls. A later preregistration must reintroduce model cells,
longer gaps, paraphrased cues, multiple seeds, and a public reproducible Agent
arm.

## Frozen question and four cells

Four literal base tasks cover two task families and seeds 501–504. Each expands
to four explicit cue types, producing sixteen scenarios:

- `positive`: resume the current action;
- `do-not-resume`: abstain because the current cue explicitly forbids resume;
- `cancelled`: abstain because a later record cancels the task; and
- `superseded`: resume only the later replacement action, never the initial one.

Every scenario is crossed with four representation cells, for 64 deterministic
case rows:

| Cell | Exact input | Decision it can change |
|---|---|---|
| `content-raw` | At most four token-overlap-ranked raw records | Reference evidence deficit |
| `association-raw` | Up to two repeated-position records, then content records, four total | Whether repeated proximity deserves a later Agent test |
| `deterministic-checkpoint` | One source-cited checkpoint built from the identical association packet | Whether checkpoint representation is non-inferior and materially smaller |
| `checkpoint-association-raw` | That identical checkpoint plus the byte-identical association packet | Whether composition adds enough success to justify duplication |

The checkpoint does not get better retrieval than association raw. The combined
cell cannot silently use different raw records. Those equality constraints are
necessary to attribute a difference to representation rather than evidence.

## Repeated-position evidence

The unit is one immutable source record. Tokens are Unicode-normalized and use
a small frozen alias table. A token-pair association is admitted only when the
two tokens occur in adjacent records in at least two distinct episodes.
Repeated appearances in one episode do not count.

Retrieval first selects content records. Tokens in the cue and content records
seed one association traversal. The top two associated records precede content
records; exact source identifiers are deduplicated and the packet stops at four
records.

This implements only a candidate for the owner's requested effect that repeated
nearby meanings may help recover position-related or causal-related context.
The graph itself has no causal semantics. A causal claim is allowed only when a
source record explicitly states it.

## Closed action and cue ground truth

The decision output has exact fields for decision, reason, task identity, task
state, action, constraint, citations, and uncertainty. Actions are not scored as
free prose. They use one of four closed operations with exact argument keys:

| Operation | Arguments |
|---|---|
| `add_idempotency_guard` | `idempotencyKey` |
| `reconcile_duplicate_deliveries` | `batchId` |
| `restart_service` | `serviceName` |
| `revert_release` | `releaseId`, `serviceName` |

A human-readable phrase such as “add an idempotency guard” is therefore invalid
even if it sounds close. This isolates representation validity from the prior
surface-form mismatch.

The verifier derives ground truth again from source text rather than trusting
the stored label:

| Cue | Required decision | Required state/action support |
|---|---|---|
| positive | `resume/current_action` | current-state source plus either sufficient constraint source |
| do-not-resume | `abstain/explicit_do_not_resume` | no state, action, or constraint citation |
| cancelled | `abstain/task_cancelled` | later cancellation for state and action; no constraint citation |
| superseded | `resume/superseded_action` | later supersession for state/action plus either constraint source |

`oldActionUse` is independently counted when a response uses the initial action
after do-not-resume, cancellation, or supersession, or cites the older current
record as its action support. `falseResume` is separately counted for resume on
do-not-resume or cancelled cues.

## Citation OR-set semantics

Each semantic claim owns one or more independently sufficient source sets. A
claim is covered if all identifiers in at least one set are cited. For the two
equivalent constraint records, the sets are `{C1}` OR `{C2}`:

- citing C1 succeeds once;
- citing C2 succeeds once;
- citing both succeeds once and records corroboration count 2; and
- citing a current-state or anchor record as constraint support fails claim
  precision even if that record exists in the evidence packet.

Citations must also resolve through the packet's one-hop raw-source closure. A
checkpoint identifier cannot hide a fabricated source identifier.

## Metrics and decisions

The primary metric is binary `semanticCaseSuccess`: all exact fields, all
required claim groups, claim precision, source closure, and both safety flags
must pass. Aggregates never replace per-case rows.

Frozen minimum changes are:

- association versus content: at least two net successes among eight positive
  and superseded pairs (`+0.25` absolute), with no paired regression;
- deterministic checkpoint versus association: at most one loss among sixteen
  pairs and at least 25% p95 evidence-byte reduction;
- checkpoint plus association versus association: at least two net successes
  among eight action-bearing pairs, no paired loss, and p95 bytes at most 1.50×;
- every candidate: zero false resume, old-action use, invalid citation, and
  unrelated citation, with all twelve negative/state-update cases correct.

The small literal corpus supports exact mechanism screening, not population
inference. Its nominal 95% field records the experiment protocol, but no
confidence interval can turn 16 constructed scenarios into a general Memory
claim.

## Evidence chain and mutation boundary

The implementation is isolated under
`scripts/experiments/probes/memory-factorial-v0/`:

1. `dataset.mjs` creates records, retrieval, association edges, checkpoints,
   and the four evidence packets.
2. `scorer.mjs` implements the closed reference reader and claim-group scorer.
3. `run.mjs` verifies registered implementation and dataset hashes, then writes
   `run-freeze.json` before computing any checkpoint, case, or aggregate.
4. `verify.mjs` imports only Node built-ins. It independently duplicates source
   parsing, retrieval, checkpoint, scoring, and aggregation, and reads formal
   artifacts without treatment imports.
5. `run-mutation-tests.mjs` alters one property at a time and requires the
   verifier to reject every mutated bundle.

The canonical preregistration snapshot—not the repository file's indentation—is
the byte sequence hashed in `run-freeze.json` and written as
`preregistration.json`. A dedicated checked-in JSON Schema and cross-field
validator close the preregistration boundary without depending on unrelated
workspace drafts. Dataset JSONL and all seven result-affecting script files
have hashes registered before any formal output.

The mutation set contains independently failing counterexamples for:

- natural-language action surface form;
- cross-claim constraint citation;
- stored action after do-not-resume;
- stored action after cancellation;
- initial action after supersession;
- one missing case row;
- a tampered aggregate; and
- a changed frozen source record.

The conformance test also proves that C1, C2, and C1+C2 have the intended OR-set
behavior and that the independent verifier contains no local treatment import.

## Expected fixture behavior is not a formal result

The deterministic reader is constructed to expose the intended contrast:
content retrieval lacks a constraint on the eight action-bearing cases, while
association retrieves the two constraint alternatives plus the needed current
or replacement action. In-memory conformance checks therefore exercise the
expected pass/fail path. They do not create a versioned result directory and do
not authorize an efficacy classification.

Even a future valid formal deterministic run could change only these choices:

- carry repeated-position raw evidence into a public Agent experiment;
- prefer raw association over a checkpoint that is not materially smaller;
- reject redundant checkpoint-plus-raw composition when it adds no paired
  success; and
- keep automatic task resume disabled on any negative-cue or old-action failure.

It cannot establish model use, context robustness, learning, Dolly integration,
restart recovery, deletion propagation, namespace isolation, Scheduler
behavior, or real tool safety. The Module startup refusal remains untouched.

## Required next experiment

The next version must use a public, reproducible Agent backend and must not tune
on these sixteen evaluation cases. At minimum it needs held-out task families,
longer interruption gaps, paraphrased positive and negative cues, multiple
generator and decoder seeds, raw per-call records, strict transport validation,
and the same closed action and claim-group scorer. Generated checkpoint cells
belong there only if checkpoint construction is itself source-cited and scored.

Owner Aether may later be a separately reported deployment replication using
strict streaming, but it cannot replace or rescue the public baseline. Only a
non-empty `reasoning_content` field would prove reasoning for a particular
Aether call.
