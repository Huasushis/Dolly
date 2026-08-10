# General Agent tool-registry vertical evidence

Date: 2026-08-10

## Supported effect, unsupported product boundary

The current candidate proves a narrow but real effect: a Scheduler-driven,
process-isolated Agent can inspect a Host-selected read-only tool registry, run
one text reasoning plan, issue strict JSON actions, retrieve private Module data
without receiving a raw storage handle, and commit a source-citing answer.

This is not product Module support. `runtime-bootstrap.ts` still refuses every
configured Module with `RUNTIME_MODULE_MIGRATION_REQUIRED`. The canary assembles
real Core components outside product bootstrap, uses an in-memory tool journal,
does not prove delegated Linux control-group ownership, and depends on one
private Aether fixture.

## Versioned observations

| Version | Outcome | Decision-changing observation |
| --- | --- | --- |
| registry-v1 | Inconclusive | The Agent completed the registered read-only tool sequence, but the model wrapped the final JSON in prose/Markdown. Strict parsing quarantined the Run. |
| registry-v2 | Inconclusive | Combining required reasoning with JSON-object output returned HTTP 200 and non-empty `reasoning_content`, but `content` was null. This disproved the assumed combined call contract. |
| registry-v3 | Complete effect, invalid confirmation | Both treatments listed and read the right source and recovered `EMBER-7421`. One returned `answer` as an object, exposing an under-specified final action; the manifest's all-or-nothing string scorer reported 0.5. The verifier also assumed the wrong order for the sorted capability description. |
| registry-v4-a | Infrastructure-inconclusive | The third logical call returned `PROVIDER_UNAVAILABLE`. The run stopped and the Scheduler quarantined the Module. The experiment transport also failed to retain the non-2xx response body, which is an evidence defect. |
| registry-v4-b | Effect complete; confirmation still pending | The single preregistered infrastructure replacement completed all cases and calls. Both treatments returned the canonical string answer and both baselines withheld the hidden value. Independent validation stopped on a local verifier bug: it read `input.maxOutputTokens` instead of `budgets.maxOutputTokens`. |

No model-content failure was retried. The only replacement was the separately
identified registry-v4-b run allowed by the frozen infrastructure rule.

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

## Engineering decisions

1. Keep separate calls for text reasoning and JSON actions on this endpoint.
   Non-empty `reasoning_content` is required only for the planning call.
2. Treat planning text as untrusted context. Authority remains the Host registry,
   active-Run capability scope, ToolPolicySession, and closed action validator.
3. Require final `answer` to be one non-empty string. Object-valued answers,
   prose extraction, and Markdown fences fail before commit.
4. Preserve `model-operation/v2` and `ChatInput/v3`; do not infer JSON Schema
   conformance or native function calling from JSON-object syntax.
5. Fix the independent verifier against the frozen broker budget location and
   independently recompute request messages, token limits, accounting, hashes,
   and all registered mutations before a future confirmation run.
6. Retain non-2xx provider bodies within the response-byte limit so an
   infrastructure classification has raw status/body evidence.
7. Do not remove the product Module startup refusal. The next Scheduler product
   boundary remains durable external-effect evidence and output-commit safety,
   not a bootstrap bypass.

## Post-v4 hardening status

After preserving the exact v4 implementation in commit `799de89`, the next
engineering revision corrected the verifier to read the frozen token limit from
`model-call.budgets.maxOutputTokens`. It also changed the bounded experiment
transport to drain and retain a non-2xx response body before returning control
to a broker that may reject solely from the status code. A local loopback test
proves a 503 body is recorded even when the caller never consumes the returned
body stream. These fixes do not retroactively validate registry-v4-b; a future
confirmation must freeze their new source hashes before making provider calls.
