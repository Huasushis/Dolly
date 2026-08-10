# General Agent tool-registry vertical evidence

Date: 2026-08-10

## Supported effect, unsupported product boundary

The current candidate proves a narrow but real effect: a Scheduler-driven,
process-isolated Agent can inspect a Host-selected read-only tool registry, run
one text reasoning plan, issue strict JSON actions, retrieve private Module data
without receiving a raw storage handle, and commit a source-citing answer.

This is not product Module support. `runtime-bootstrap.ts` still refuses every
configured Module with `RUNTIME_MODULE_MIGRATION_REQUIRED`. The canary assembles
real Core components outside product bootstrap, uses persistent file-backed
tool-round and exact-Run capability-effect journals, does not prove delegated
Linux control-group ownership per canary case, and depends on one private Aether
fixture.

## Versioned observations

| Version | Outcome | Decision-changing observation |
| --- | --- | --- |
| registry-v1 | Inconclusive | The Agent completed the registered read-only tool sequence, but the model wrapped the final JSON in prose/Markdown. Strict parsing quarantined the Run. |
| registry-v2 | Inconclusive | Combining required reasoning with JSON-object output returned HTTP 200 and non-empty `reasoning_content`, but `content` was null. This disproved the assumed combined call contract. |
| registry-v3 | Complete effect, invalid confirmation | Both treatments listed and read the right source and recovered `EMBER-7421`. One returned `answer` as an object, exposing an under-specified final action; the manifest's all-or-nothing string scorer reported 0.5. The verifier also assumed the wrong order for the sorted capability description. |
| registry-v4-a | Infrastructure-inconclusive | The third logical call returned `PROVIDER_UNAVAILABLE`. The run stopped and the Scheduler quarantined the Module. The experiment transport also failed to retain the non-2xx response body, which is an evidence defect. |
| registry-v4-b | Effect complete; confirmation still pending | The single preregistered infrastructure replacement completed all cases and calls. Both treatments returned the canonical string answer and both baselines withheld the hidden value. Independent validation stopped on a local verifier bug: it read `input.maxOutputTokens` instead of `budgets.maxOutputTokens`. |
| registry-v5-a | Infrastructure-inconclusive | The planning call of the first treatment returned HTTP 504. The persistent effect boundary classified retry safety as unproven and the Scheduler quarantined the Run instead of re-executing it. |
| registry-v5-b | Effect complete; invalid confirmation | The single allowed replacement completed 4/4 cases and 10/10 calls; both treatments recovered `EMBER-7421`, both baselines withheld it, and all four exact-Run effect journals closed. The frozen verifier then incorrectly treated key-order-equivalent JSON objects as different. |
| registry-v6-a | Inconclusive | Three cases completed and both treatments executed `storage_list -> storage_get -> answer`; the last baseline call returned HTTP 504. One treatment cited tool operation names instead of the retrieved source key, exposing a real grounding-contract weakness even before the infrastructure stop. |
| registry-v6-b | Infrastructure-inconclusive | The only allowed replacement stopped on HTTP 504 in the first treatment action call. No third run was started. |

No model-content failure was retried. Each version used at most its one
separately identified whole-run replacement allowed by the frozen
infrastructure rule. All failed and replacement artifacts remain separate.

## Registry-v4-b raw outcome

- 4/4 Scheduler cases completed and exact child processes stopped.
- 10/10 logical model calls completed with one provider attempt each.
- 0 provider retries, 0 model errors, and 0 retained provider errors.
- Both treatments executed `storage_list -> storage_get -> answer`.
- Both treatments returned the non-empty string `EMBER-7421`, set `grounded`
  true, and cited `deployment-note`.
- Both baselines omitted the codename and set `grounded` false.
- Paired grounded recovery: 1.0; exact tool sequence: 1.0; observed planning
  reasoning: 1.0.
- Provider-reported total: 7,657 prompt tokens, 2,997 completion tokens, and
  10,654 tokens overall.
- Aggregate recorded model-call latency: 111,650 ms.
- Currency cost was not measured and no monetary budget is claimed. Finite
  call, token, response-byte, per-call, per-case, and run-time limits were used
  as resource bounds.

These values establish the requested demo effect. They do not satisfy the
frozen confirmatory decision because the preregistered verifier did not finish.
Changing its source after the run cannot retroactively make registry-v4 green.

## Persistent-journal canary outcome

Registry-v5-b repeated the narrow demo effect after replacing both in-memory
journals:

- 4/4 Scheduler cases, 10/10 provider calls, and 4/4 exact child stops.
- Both treatments used only `model-operation` and `tool-invocation`, executed
  `storage_list -> storage_get -> answer`, returned the string `EMBER-7421`,
  and grounded it in `deployment-note`; both baselines withheld the value.
- Every committed Run reopened with terminal, payload-free capability-effect
  evidence, and the treatment used `FileToolJournalRepository`.
- Manifest artifact hashes and configured fixture-value leakage checks pass.

This still is not a confirmatory green run: the frozen v5 verifier rejected
semantically equal provider messages because their object key insertion order
differed. A development-only replay proved the corrected semantic JSON-value
comparison accepts the retained structure, but that replay cannot reclassify
v5.

Registry-v6 froze that correction and fresh seeds. Its first run completed nine
HTTP 200 calls and three cases before the tenth call returned HTTP 504; its one
replacement stopped on another HTTP 504 after two HTTP 200 calls. Both
manifests' listed artifact digests match and neither artifact set contains the
configured endpoint or API-key bytes. The version is therefore conclusively
`inconclusive`, not rejected or supported. It also supplied a useful model
counterexample: one treatment retrieved the correct record and answer but put
`storage_list`/`storage_get` in `evidenceKeys` instead of the source key
`deployment-note`. The next design change must validate grounding against
observed source identities rather than relying on a prompt or non-empty-string
schema alone.

## Engineering decisions

1. Keep separate calls for text reasoning and JSON actions on this endpoint.
   Non-empty `reasoning_content` is required only for the planning call.
2. Treat planning text as untrusted context. Authority remains the Host registry,
   active-Run capability scope, ToolPolicySession, and closed action validator.
3. Require final `answer` to be one non-empty string. Object-valued answers,
   prose extraction, and Markdown fences fail before commit.
4. Preserve `model-operation/v2` and `ChatInput/v3`; do not infer JSON Schema
   conformance or native function calling from JSON-object syntax.
5. Compare provider request bodies as semantic JSON values while separately
   checking the exact serialized request hash. Independently recompute request
   messages, token limits, accounting, hashes, and all registered mutations.
6. Retain non-2xx provider bodies within the response-byte limit so an
   infrastructure classification has raw status/body evidence.
7. Do not remove the product Module startup refusal. The next Scheduler product
   boundary remains durable external-effect evidence and output-commit safety,
   not a bootstrap bypass.
8. Bind final `evidenceKeys` to exact successful tool observations. A model that
   names a tool operation instead of the retrieved source must fail before
   commit even if its answer text is correct.

## Post-v4 hardening status

After preserving the exact v4 implementation in commit `799de89`, the next
engineering revision corrected the verifier to read the frozen token limit from
`model-call.budgets.maxOutputTokens`. It also changed the bounded experiment
transport to drain and retain a non-2xx response body before returning control
to a broker that may reject solely from the status code. A local loopback test
proves a 503 body is recorded even when the caller never consumes the returned
body stream. These fixes do not retroactively validate registry-v4-b; a future
confirmation must freeze their new source hashes before making provider calls.

The next candidate also replaces the per-process in-memory tool-round journal
with the strict, atomically replaced `FileToolJournalRepository`. A real child
process conformance test completes both read rounds, reopens the file, and finds
both rounds terminal without changing the two tool executions. The journal now
binds each Module job to one registry digest and approval-policy revision. This
is read-only crash-recovery infrastructure, not evidence that an effectful tool
is safe after a crash between its external effect and terminal journal update;
the registry-v5/v6 runner additionally routes capabilities through the
Host-owned persistent effect lifecycle, supplies the same journal as the Runtime
recovery evidence source, and requires the committed Run to reopen as
`terminal`. Registry-v5 exercised that path with seeds 7425/7426; registry-v6
then exercised fresh seeds 7427/7428 and exposed both endpoint 504 instability
and the source-identity grounding counterexample. Neither version rewrites or
reclassifies earlier evidence.
