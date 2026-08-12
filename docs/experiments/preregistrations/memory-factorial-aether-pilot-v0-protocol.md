# Memory factorial Aether pilot protocol v1

This protocol governs only `memory-factorial-aether-pilot-v0`. It is an
exploratory, owner-endpoint mechanism-selection pilot and cannot authorize a
product Memory design or Dolly Module startup.

## Before the first call

- Freeze the question, factorial cells, scenario seeds, prompts, request
  profiles, retry policy, call and wall-clock bounds, metrics, minimum effects,
  guardrails, decision rules, artifact inventory, and independent mutations.
- Commit and hash the preregistration, this protocol, runner, scoring code,
  strict SSE parser, and independent verifier.
- Do not inspect the eight evaluation outcomes before the freeze.

## Execution

- Require explicit `RUN_LIVE_INTEGRATION=1` and `RUN_PAID_INTEGRATION=1`.
- Use only the configured Aether origin and `qwen3.6-27b` capability profile.
- Every successful response must use strict SSE streaming with one terminal
  usage event and one `[DONE]`; there is no non-stream or backend fallback.
- Use `thinking.type`, never `enable_thinking`. Only a nonempty returned
  `reasoning_content` proves reasoning for that particular call.
- Retry only the preregistered transport and retryable HTTP failures. Persist
  every attempt before parsing. Never retry an HTTP 200 content failure.
- Never launch a Dolly Module, remove the public Module startup refusal, or
  send private project data. The generated scenarios are synthetic.

## Evidence and classification

- Preserve the frozen dataset, condition-specific evidence, every checkpoint,
  every Agent case, raw request and provider response data, exact per-case
  scores, aggregate analysis, manifest, checksums, and validation result.
- Keep retrieval evidence, extractive checkpoints, and generated checkpoints
  distinguishable and source-cited.
- A complete pilot has exactly 16 generated-checkpoint calls, 48 Agent calls,
  32 checkpoint rows including deterministic extractive rows, and 48 case rows.
- Coverage, stream, retry, source, secret, checksum, or independent-validation
  failure makes the run inconclusive before efficacy is considered.
- Report checkpoint, association, composition, and extractive-noninferiority
  decisions separately. A passing factor does not validate another factor.
- Positive-only Aether results remain exploratory even when every registered
  threshold passes. Negative-cue, obsolete-memory, held-out task-family, and
  public-backend confirmation are required before product integration.

## Independent verification

The verifier must not import the treatment implementation. It must recompute
dataset truth from source roles and text, independently rebuild content and
association evidence, recompute checkpoint and Agent scores and all factorial
effects, verify request/retry/stream contracts and file hashes, and reject each
registered mutation. Configured endpoint and credential values are read only
for leak detection and must never be written to artifacts or reports.
