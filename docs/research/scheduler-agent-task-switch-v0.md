# Scheduler-driven Agent task switching: exploratory result

Date: 2026-08-10

Run: `task-switch-v0-20260810f`

Source commit: `8e20bcaf90ab9f7c592049b963ba134a1cf03675`

Preregistration SHA-256: `ca4512d4d3dac46790995da6d293804792b1828682c6efc3c0c664f0aad32147`

## Result

The frozen version-6 canary is **candidate-supported for this one synthetic
task sequence**. It is not evidence for a final Memory architecture or for
product Module startup.

One process-isolated Agent completed three distinct Scheduler Runs in each
condition: checkpoint task A, complete unrelated task B, then resume task A.
The no-checkpoint baseline correctly reported that it could not resume. The
structured-checkpoint condition stored one source-citing checkpoint through
Host tools, answered task B, then listed and read that checkpoint and committed
the exact next action and evidence key.

The independent verifier passed with:

- 2/2 complete conditions and three distinct Runs per condition;
- 11/11 live provider calls and no provider retry;
- zero task-A value leakage into task B or the first resume planning input;
- one Module generation and one process per condition;
- all capability effects terminal and all three tool rounds persisted;
- 11/11 secret leases released;
- 5/5 preregistered artifact mutations rejected; and
- the product `RUNTIME_MODULE_MIGRATION_REQUIRED` refusal retained.

## Streaming evidence

All eleven model requests sent `stream: true` with
`stream_options: {"include_usage": true}`. There was no non-stream fallback.
The Broker required `text/event-stream`, validated chunks incrementally, kept
reasoning and final text separate, and required a finish reason followed by
`[DONE]` before returning one terminal result to the Agent.

The retained streams contain 537 SSE events and 112,246 bytes in total. Each
call contains terminal token usage; total provider usage was 13,416 tokens.
The two reasoning-required planning calls independently reconstructed non-empty
`reasoning_content` of 999 and 3,153 characters. The verifier rebuilt all SSE
content and compared it byte-for-byte with the Broker's normalized outputs.

The earlier version-5 HTTP 504 occurred near the gateway's then-configured
120-second timeout. The owner subsequently raised that timeout to 24 hours.
That explains the infrastructure failure but does not change version 5 into
Agent evidence. Version 6 is a new, separately frozen run.

## What changed in Dolly

The strict SSE decoder already existed, but `ChatModelBroker` rejected every
stream request. Version 6 connects that decoder to the bounded HTTP body,
selects the exact response media type, requests terminal usage, and exposes
provider streaming only through an explicit Host capability grant. Partial,
malformed, oversized, wrong-media-type, or post-terminal streams fail closed.
Extensions still receive only the validated terminal output; provisional
progress delivery remains a separate future interface.

Related deterministic evidence at the frozen source revision:

- 86 model-provider, capability, and task-switch tests passed;
- TypeScript type checking passed; and
- the preregistration schema and cross-field structure check passed.

## Limits and next decision

This is one synthetic sequence on the owner's optional Aether deployment. It
does not establish cross-model generality, learned association, consolidation,
sleep, Linux control-group ownership, installed-package provenance, or safe
product startup. It does show the requested end-to-end effect on the candidate
Scheduler composition and supports using the source-citing structured
checkpoint as the first simple task-resumption boundary.

The next engineering step is to retain this effect while moving the candidate
composition behind the installed Linux Module factory and adding restart,
duplicate, malformed-checkpoint, and hard termination counterexamples. Richer
Memory retrieval factors remain an independent factorial experiment and must
not be inferred from this result.

## Local raw evidence

The raw evidence is retained under
`artifacts/experiments/probes/scheduler-agent-task-switch-v0/runs/task-switch-v0-20260810f/`
and remains ignored by Git because it includes private model prompts and raw
reasoning. Key digests are:

- `provider-responses.jsonl`: `59fb96e7887fcd24f9c7705e533f7b4615aa625ea8514c4290ab0bb17573f93e`
- `model-calls.jsonl`: `3bda8eea2c8823676f34d3a7ad36c8df35f54ffc6476ba56239e5f5eeb68a36b`
- `cases.jsonl`: `aa77f2d718423276129bab2c556c431ea7010fb7aa2dd4951dbd3ad2e1b87dc0`
- `validation.json`: `0b4e2ec6b9dcec91bff0b2ffe0bc743ba296a6c680bdf89ce7da142dc8267ff9`
