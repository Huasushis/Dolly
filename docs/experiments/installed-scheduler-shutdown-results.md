# Installed Scheduler shutdown cancellation result

Date: 2026-08-10 UTC

Source: `7df85014fed59ff7dcde896e84089cb6822ddfc4`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

When an installed process ignores cooperative cancellation and the Host must
terminate its Linux control group during shutdown, does Dolly release the
active Claim as a shutdown cancellation, or does it incorrectly record a
failed attempt and dead letter?

The counterexample was observed in the earlier backpressure diagnostic: the
slow drainer's active Run crossed its cancellation grace, its process exit was
mistaken for an independent crash, and the Run was classified as `fenced`.

## Result

The isolated Actor counterexample failed before the fix with `status=fenced`.
After the fix, 89 focused Actor/Runtime/real-process tests passed, followed by
the complete Core and bootstrap regression: 51 files, 786 tests passed and 3
skipped. TypeScript type checking also passed.

The exact Linux integration then passed 1/1. After the existing three-process
backpressure pipeline had drained, a new Delivery started a third slow drainer
Run. The fixture ignored `dolly.cancel`; the 1-second cancellation grace
expired and Dolly terminated the exact process control group. Reopening the
Core files showed the Module job as `ready`, attempt 1, failed-attempt count 0,
with its Delivery pending for a future generation and no dead letter. This
distinguishes shutdown cancellation from both retryable execution failure and
unknown external-effect recovery.

All three process records reached `stopped`, and all exact Module control
groups were removed. The runner removed only its exact container and image,
`dolly-experiment-965065-64de3e2f`; post-run exact inspection found both
absent.

Evidence is in
`docs/experiments/evidence/installed-scheduler-shutdown-7df8501/`.

## What this does not prove

The tested Module declared no external effects. A Run with incomplete durable
external-effect evidence must still remain isolated for recovery rather than
being released. This test also does not prove crash recovery after an
unconfirmed termination, periodic scheduling, general tool/model capability
composition, or public Module startup support.

`openDollyRuntime` remains closed for configured Modules with
`RUNTIME_MODULE_MIGRATION_REQUIRED`.
