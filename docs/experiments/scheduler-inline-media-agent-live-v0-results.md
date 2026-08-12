# Scheduler inline-Media Agent live result

Date: 2026-08-12 UTC

Experiment: `scheduler-inline-media-agent-live-v0`

Registered version: 2

Successful run: `live-v2-20260812a`

## Result

The registered candidate passed after one pre-provider failure exposed and
removed an invalid process-record self-report. In the successful run, one
Scheduler Claim delivered a text instruction and one local PNG reference to a
real Extension process. The Extension received only a `model-operation/v3`
handle, where version 3 means that the closed capability argument may carry a
Host-granted immutable Media reference but not image bytes, a path, a URL, an
access mode, or a provider placement strategy. The Host-side broker authorized
that reference against the same active Claim, copied the local bytes, made one
strict streaming Aether request, and atomically committed one output Block.

The exact fixed image answer passed. This result supports retaining the narrow
version-3 delivered-image path as the next reversible general-Agent input
slice. It does not support public Module activation or a general vision claim.

## Registered observations

- Provider dispatches: 1; retries: 0; non-stream fallback: 0.
- Request: `stream=true`, `stream_options.include_usage=true`,
  `thinking.type=disabled`, no `enable_thinking`, JSON-object output, and one
  Host-constructed inline PNG part.
- Response: HTTP 200 `text/event-stream`; 39 chunks and 8,215 bytes; final
  chunk after 7,748 ms; terminal finish reason `stop`.
- End-to-end measured interval from input wait to orderly stop: 7,934 ms.
- Model reasoning observation: `not-observed`. The result therefore makes no
  claim that this disabled-thinking call used reasoning.
- Scheduler: one committed result, zero pending input, one pending output for
  the sink, zero active Claims, zero dead letters, and final state `stopped`.
- Media: the inspected 640×360 PNG was 21,283 bytes; provider-access records
  and remaining leases were both zero after completion.
- Effects and secrets: the model effect was `terminal` before and after
  reopening the file journal, and the secret lease released exactly once.
- Process: the exact recorded child was alive before orderly shutdown, absent
  afterward, and its durable process record was `stopped`. The child reported
  no Aether endpoint or key in its environment.
- The result records `linuxControlGroupProof=false`. Separate disposable
  systemd-container tests cover the installed Linux control-group path; this
  live run does not merge that separate evidence into its claim.

## Failed registered version

Version 1 run `live-v1-20260812a` stopped before Extension startup and before
any provider request. Its runner wrote `/candidate/no-cgroup-proof` into a
`dolly.module-process-record/1`. The durable validator correctly rejected that
path because it was not derived by Core. The retained FileCore state contains
one registered Media item but zero Blocks, Deliveries, Claims, process records,
submissions, effects, or result records. Version 2 changed only that false
record to `deriveModuleCgroupPath(...)`, retained
`linuxControlGroupProof=false`, and added a real-child no-network preflight.
That preflight passed and terminated its exact PID.

The version-1 copied preregistration and failure record remain under
`artifacts/experiments/probes/scheduler-inline-media-agent-live-v0/live-v1-20260812a/`;
the exact scratch is retained at
`/home/ubuntu/codex-dolly/.tmp/scheduler-media-agent-cyZCGZ`.

## Independent validation and oracle correction

The original independent validator correctly passed every result check but
reported one false negative: it looked for an obsolete substring of the public
Module refusal message. The current source says:

`Configured Modules require the isolated extension process runtime; refusing the legacy in-process Orchestrator`

The original `validation.json` is preserved with SHA-256
`cb2aaee0fdabe36bd952c117e7c98d2cde6bc444271a628d7e62c9e90bb86e81`.
It was not overwritten. A separate repair validator changed only that exact
message oracle, pinned the original validation hash and unique error, and
rechecked all registered hashes and terminal states. Its
`validation-v2.json` is valid with SHA-256
`24ed9771c5e74248447226ba453be323692c329c43dc7b0517b8170822d57102`.
The existing runtime-bootstrap conformance suite independently passed 8/8 and
still proves that configured Modules fail with
`RUNTIME_MODULE_MIGRATION_REQUIRED` before Core state or controller ownership
is created.

## Evidence inventory

Successful-run hashes:

- copied preregistration: `c4cc874aadf76230f524bf52f1a1938c6c79e49638a600f473d84dc969fc643a`
- manifest: `f58f4b77c30f5ac3123ad8639deed570abec852c8b77127702762d8d8b66d3fa`
- sanitized result: `262eaf2d22274fb00115b0b2972e330dff2754d9e0f6b9891069c6a4c797acb0`
- effect-intent journal: `b0fca9423b7a2080a5863ebeefcc7f0f2d26578753bb1e4da44c429666ba3451`

Raw provider event text, image bytes, data URL, authorization header, endpoint,
credential, and provider reasoning text are intentionally absent. The manifest
pins the exact runner, Extension, verifier, and 28 production source files used
by the run.

## Support boundary and next decision

This is one deterministic paid canary on the owner's optional deployment. It
does not show repeatability, public reproducibility, model-family portability,
multiple images, crops, JPEG, URLs, OSS, provider upload, native tool calls,
automatic retry, or public Module support. Ordinary process isolation in this
run also does not prove ambient filesystem/network/subprocess denial; failures
after an uncertain effect must remain quarantined.

The next engineering step is to reuse the same Host-only active-Claim Media
resolver inside the already-tested installed Linux Scheduler composition and
run it in the unique disposable systemd container, without giving the
Extension credentials or network authority. The public bootstrap refusal must
remain until that installed chain, configuration provenance, restart recovery,
and whole-group termination are closed together.
