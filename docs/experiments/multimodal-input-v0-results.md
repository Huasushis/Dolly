# Multimodal input v1 result

Date: 2026-08-12 UTC

Source: `d2bec292902d9ff3e43100f3ad0d8b3c6639606c`

Run: `v1-20260812a`

## Question

Can Dolly's candidate endpoint/model adapter send bounded local PNG bytes as
an inline base64 data URL to the owner's configured Aether `qwen3.6-27b`,
receive a complete strict-SSE response, and obtain an answer that is actually
grounded in the image rather than the prompt? Separately, are the local file
reader and private signed-URL lifecycle contracts precise enough to guide a
future product implementation without depending on Aether or owner object
storage?

## Corrected protocol boundary

The first execution is retained as an invalid version-0 run. Its runner
reported 34/34 checks and the model answered all five live cases, but the
independent verifier found that the SVG declared as 640 by 360 pixels was
rasterized at 96 DPI into 853 by 480 pixels. That result is not registered
evidence.

Version 1 changed only the SVG rasterizer density to 72, which produced the
predeclared 640 by 360 PNG, and introduced immutable run identifiers so failed
runs cannot be overwritten. The corrected image contains a title, a nonce,
three colored labeled number boxes, and an answer rule. Its SHA-256 is
`bc238ff86859388b5b268df435a6d3a5083df998f572488ebf6852c067618d0e`.

## Result

The corrected matrix passed 34/34 registered executions and the independent
verifier passed all 34. The local deterministic cases established:

- exact inline PNG transfer with size, MIME, dimension, request-size, and
  truncation counterexamples;
- stat-first, digest-bound, maximum-64-byte file chunks with reconstruction,
  oversize-read rejection, and changed-file rejection;
- version-pinned private signed URLs in the local object-store simulation,
  including signed crop, expiry, tamper, lifetime clamp, version update, and a
  failed delete followed by recorded recovery; and
- endpoint/model profile selection among inline, URL-only, and text-only
  behavior without provider-name inference.

The five real Aether calls also passed:

| Case | Result | Duration | Prompt / completion tokens |
| --- | --- | ---: | ---: |
| no-image control | did not reproduce the hidden visual answer | 5.892 s | 105 / 158 |
| image repetition 1 | exact full answer | 5.487 s | 327 / 147 |
| image repetition 2 | exact full answer | 5.653 s | 327 / 147 |
| image repetition 3 | exact full answer | 6.359 s | 327 / 147 |
| grounded follow-up | exact `59` | 5.880 s | 526 / 13 |

Every generation request used `stream=true`,
`stream_options.include_usage=true`, `thinking.type=disabled`,
`response_format.type=json_object`, and no `enable_thinking`. Every response
was HTTP 200 strict SSE with one terminal usage event, one `[DONE]`,
`finish_reason=stop`, and empty `reasoning_content`, as required for this
bounded extraction role. There was no retry or non-stream fallback.

The no-image control is a useful counterexample: it invented a different
title, nonce, box labels, and numbers. Only the three image cases returned the
exact title `DOLLY VISUAL CHECK`, nonce `K8M2`, ordered values 7/4/9, checksum
20, and answer token 12. The follow-up replayed the first image turn and
returned `(7 * 9) - 4 = 59`.

The model-listing metadata request returned HTTP 200, reported 23 model IDs,
and contained the configured target. It was bounded JSON metadata, not a
generation request, so it was not misrepresented as SSE.

## Evidence

Artifacts are retained under
`artifacts/experiments/probes/multimodal-input-v0/runs/v1-20260812a`.

- `raw-cases.jsonl`:
  `a401fcfceea67a12ac583ec97eb158bce30ce60e701c77c726d3a7db2d12fa6c`
- `summary.json`:
  `82354d4242c80db6f734d97ae8d97b469cfac01b7a447af52d7618bb8fc77b74`
- `verification.json`:
  `1542b9944957db3cfbed0561aa081ed8c8ba5b952de369553acc1b13bfc5f31f`

The verifier recomputed the registered case inventory, implementation and
consumer hashes, artifact inventory and hashes, request digests, exact PNG
bytes and dimensions, all five strict-stream profiles, image and follow-up
answers, file-chunk reconstructions, summary counts, and the continued Module
startup refusal. It scanned every artifact for the configured endpoint and
credential bytes and found neither.

## Engineering decision

The exact configured Aether `qwen3.6-27b` profile is provisionally
inline-PNG-capable for this fixed task. Local bytes/base64 should therefore be
the first media adapter implemented for exact profiles that declare and pass
the same constraints. The signed-URL path remains an optional URL-only design;
the local simulation is not evidence about Aliyun Object Storage Service,
owner permissions, real signed cropping, deletion permission, or model fetch
behavior.

This is not broad visual benchmark evidence and does not establish automatic
image-tool selection. The current product chat codec still rejects unresolved
media references; it lacks the profile-selected media wire codec and cleanup
boundary. `openDollyRuntime` still rejects every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. The result guides the next reversible
adapter slice; it does not authorize removal of that safety condition or make
Aether a required Dolly dependency.
