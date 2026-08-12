# Gateway strict-SSE canary v0

Run `run-20260812a` made exactly one Aether request from commit `12959a5`.
It used `stream=true`, terminal usage, `thinking.type=enabled`, no
`enable_thinking`, no retry, and no non-stream fallback. The request used the
configured `qwen3.6-27b` model identifier; endpoint and credential values were
not written to artifacts.

## Result

The network and gateway stream crossed the former 120-second boundary and
ended cleanly:

- HTTP 200 and `text/event-stream; charset=utf-8`;
- response headers at 2.916 seconds and first body bytes at 2.919 seconds;
- terminal completion at 143.194 seconds;
- 289,133 response bytes in 1,389 observed network chunks;
- 1,399 parsed SSE events, one usage event, and one `[DONE]` marker;
- maximum gap between successive network chunks: 890.479 milliseconds; and
- non-empty `reasoning_content` with 8,764 characters.

This is direct evidence that the changed gateway carried this strict stream
past 120 seconds without cancellation. It is not an overall canary pass. The
model consumed the full 5,200 completion-token budget, returned
`finish_reason=length`, and produced no final `content`. The frozen result is
therefore `failed` with `MODEL_CONTENT_INVALID`. The run was not retried.

The failure isolates the remaining issue from the old gateway timeout: on this
deployment, reasoning and final content share the completion budget, so the
endpoint/model request profile must reserve enough output capacity or use a
different measured thinking policy.

## Independent reconstruction

The first independent replay intentionally remains as a failed validation. It
fed the whole saved response as one synthetic chunk and hit the 256 KiB
per-buffer limit, showing that byte identity alone does not reproduce a stream
parser input. The second replay used the saved 1,389 chunk lengths, independently
reconstructed the complete strict SSE result, verified every manifest digest,
preserved the failed semantic classification, confirmed the raw terminal chunk
after 120 seconds, and found no configured endpoint or credential bytes.

Evidence root:
`artifacts/experiments/probes/gateway-strict-sse-v0/run-20260812a`

- `response.sse`: `2398bbe052d8649c96361fe931a3eee84d65e4da88fc247f33d186a17d467342`
- `chunk-timings.jsonl`: `e91ea7a78988d45d2715ae076cf84fb8278ddb3e67b0e667c430ae29a61dfa29`
- `result.json`: `a8f797ffa37b2623005b3a005a6e3a059cae85a853a40ee1f18bbc8ee087f4f9`
- failed `validation.json`: `4cd5538dbf8dceb5eb1076018465a62a0999cb1d57110c97dc6a31aecb43dba1`
- passing `validation-2.json`: `a1994ad9abdfb215fda4b02f313d64f722a006bbdafa6dad04e160530dbb49d7`

This canary did not start Dolly, a Module, a browser, a server, a container, or
a background process. `RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged.

## Version 1: completion-budget ablation

Version 1 changed only the completion budget from 5,200 to 6,400 tokens and
added an explicit instruction to reserve final-answer capacity. It retained
the model, task, seed, `thinking.type=enabled`, strict SSE contract, one-call
limit, and no-retry rule.

Run `run-20260812b` again passed the independently reconstructed transport
boundary: HTTP 200, 1,805 network chunks, 1,834 SSE events, unique usage and
`[DONE]`, a last chunk after 149 seconds, and a maximum inter-chunk gap of
749.821 milliseconds. Its raw stream therefore supplies a second direct
gateway-over-120-seconds observation.

The model-content gate failed again. It used all 6,400 completion tokens,
reported 5,049 reasoning tokens and 14,683 reasoning characters, ended with
`finish_reason=length`, and emitted no final content. Increasing the budget did
not resolve the problem and is rejected as the next engineering step. The next
version must instead test the already measured role-specific thinking policy:
strict streaming with `thinking.type=disabled` for a short structured response,
while retaining `enabled` plus non-empty reasoning evidence for calls that
actually require planning.

Version 1 evidence root:
`artifacts/experiments/probes/gateway-strict-sse-v0/run-20260812b`

- `response.sse`: `b3c2f0a0c9310c4d961ca776c704f36989eb29c003afc38b3b194180b4404c44`
- `chunk-timings.jsonl`: `48a99601b624e0cc7b42ef1cf8129858477a688e44aac0064956cc5374e52e54`
- `result.json`: `e89f75705060531d383880211c1bb669f91cde64d4e14932a18b49b46678704c`
- passing `validation.json`: `836566d6cc84eb080e87ae78f7d0d80de73222d72ea90d4421b40fc9920b3efb`
