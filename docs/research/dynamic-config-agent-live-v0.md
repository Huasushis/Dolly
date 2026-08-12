# Dynamic configuration Agent live probe v0

Status: passed as a private-fixture, product-preintegration effect probe. It is not evidence that Dolly product configuration hot reload or public Module startup is supported.

## Question and frozen boundary

The preregistered question was whether one tool-using general Agent could:

1. read a host-owned configuration;
2. propose an exact model and context-limit replacement;
3. apply only the validated opaque plan;
4. continue after the context limit contracted;
5. make the next request with the newly selected model;
6. re-read the effective revision and finish.

The probe used the owner's optional Aether deployment. All five generative requests used strict SSE with `stream=true`, `stream_options.include_usage=true`, `thinking.type=disabled`, and no `enable_thinking` or non-stream fallback. It did not start a Dolly Module, write a product configuration, or download a local model. The frozen runner, validator, and strict SSE parser were bound by SHA-256 before the first request in commit `83161e6`.

## Result

Run `live-v1-20260812a` passed the frozen five-transition sequence:

| Round | Requested model | Estimated request tokens | Tool | Host outcome | SSE events | Raw response bytes |
| ---: | --- | ---: | --- | --- | ---: | ---: |
| 0 | `qwen3.6-27b` | 3818 | `read_configuration` | `SUCCEEDED` | 10 | 2097 |
| 1 | `qwen3.6-27b` | 3968 | `propose_configuration_change` | `VALIDATED` | 29 | 6096 |
| 2 | `qwen3.6-27b` | 4210 | `apply_configuration_change` | `APPLIED` | 10 | 2209 |
| 3 | `deepseek-v4-flash` | 146 | `read_configuration` | `SUCCEEDED` | 7 | 1478 |
| 4 | `deepseek-v4-flash` | 285 | `finish` | `COMPLETED` | 9 | 2027 |

Every response had one terminal usage event, one `[DONE]`, one reconstructed tool call, and empty `reasoning_content`. The host rejected zero operations. Immediately after apply, the recorded context estimate was 4361 tokens; the trusted host checkpoint rebuilt it to 146, below the new 1024-token limit. The post-change calls requested `deepseek-v4-flash`, and the final tool argument matched the revision returned by the post-change read.

The result contains five raw requests and five raw SSE responses. The original validator independently reparsed all five and returned `valid=true` with no failures.

## Adversarial validation

The first validator was then attacked without changing the frozen run. It rejected a raw SSE byte mutation and a reversed result tool sequence, but incorrectly accepted three mutations after their local artifact digests were adjusted:

- result `runId` drift;
- removing one response from the manifest while leaving the file on disk;
- replacing the first request's messages.

This does not change the provider responses or host transitions, but it means validator v1 alone was too weak to establish the claimed evidence binding.

A separate post-run validator v2 was therefore added without overwriting v1. It requires exact directory and manifest inventories; binds run and experiment identities; checks the preregistered implementation hashes; enforces canonical requests and exact tool schemas; reparses each raw SSE stream in bounded chunks; and independently reconstructs every message, tool result, configuration revision, context rebuild, round record, and final metric. It passed the original run and rejected all five mutation cases, including the three v1 false positives.

Two inputs remain honestly classified as runner-reported rather than independently recoverable from the saved body bytes: the `/models` response and the original HTTP `Content-Type` header. Both requested model identifiers are independently evidenced more strongly by successful strict-stream chat dispatches; SSE framing, provider identity stability, usage, `[DONE]`, and tool calls are reconstructed from the stored raw response bytes.

## Engineering decision

The effect is sufficient to retain these as product-integration candidates:

- immutable per-request configuration snapshots;
- host-owned read/propose/apply operations;
- revision-checked opaque plans;
- explicit context reconstruction when a model change reduces the context limit;
- endpoint/model capability profiles that select request encoding, including strict streaming and `thinking.type`.

It does not justify letting the model write configuration files, allowing arbitrary hot reload, accepting model-supplied context limits, or reopening Module startup. Product integration still needs durable configuration revisions, concurrent-change and restart counterexamples, provider-context overflow classification, and the installed Linux Scheduler safety boundaries. `RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged.

## Reproducibility boundary

The exact private endpoint and credential are intentionally absent from artifacts and reports. Raw provider requests and SSE responses remain under the ignored artifact root:

`artifacts/experiments/probes/dynamic-config-agent-live-v0/live-v1-20260812a`

The checked-in evidence summary and artifact digests are under `docs/experiments/evidence/dynamic-config-agent-live-v0-83161e6/`.
