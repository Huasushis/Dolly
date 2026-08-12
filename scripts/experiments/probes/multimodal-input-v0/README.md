# Multimodal input v0 probe

This probe tests local transport and lifecycle contracts plus the frozen
optional Aether `qwen3.6-27b` image task. It does not start a Dolly Module. A
real-model pass applies only to the exact endpoint/model fixture and is not
Dolly product support.

From the repository root:

```sh
RUN_LIVE_INTEGRATION=1 RUN_PAID_INTEGRATION=1 \
  node --env-file=.env scripts/experiments/probes/multimodal-input-v0/run.mjs \
  --run-id v1-<unique-suffix>
node scripts/experiments/probes/multimodal-input-v0/verify.mjs \
  --run-id v1-<same-suffix>
```

Every generation request uses strict SSE with `stream=true`, terminal usage,
`thinking.type=disabled`, and no non-stream fallback. The model-listing GET is
bounded JSON metadata and is not a generation request. Neither the configured
origin nor the credential is written to artifacts.

The runner refuses to overwrite an existing run directory. Each run is stored
under `artifacts/experiments/probes/multimodal-input-v0/runs/<run-id>`; failed
or interrupted runs remain immutable evidence.
