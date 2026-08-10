# Installed Scheduler backpressure result

Date: 2026-08-10 UTC

Source: `b94a80e1789e96425c9a60385c04cb5ee07cbce5`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

When a real downstream Module holds the only resident mailbox slot, does an
upstream installed process execute again while its already accepted result is
waiting for commit, or does Dolly preserve that result and resume only the
persistent commit after capacity returns?

This distinguishes a hard commit-time capacity boundary from the weaker design
where the Scheduler merely notices a mailbox was full before dispatch.

## Result

The exact Linux integration test passed 1/1. Three installed processes formed
`input -> first -> middle -> second -> output -> slow drainer`. The drainer
claimed the first output and held the mailbox's only resident slot. The second
producer's next result then reached the explicit `output-backpressured` state,
with one persistent prepared result and no mailbox overflow.

Before capacity returned, the first and second producers had each started two
Runs and the drainer one. After the drainer completed and capacity returned,
the two producer counts remained exactly two; only the drainer advanced to its
second Run. All six result records ultimately became committed. Reopening the
files recovered the second result as `second:1:run-2`, with no pending input,
no dead letter, and no resident output.

All three process records reached `stopped` and all three exact Module control
groups were removed. The runner removed only its exact container
`dolly-experiment-956832-85b6ab60`; a post-run inspect found it absent.

Evidence is in
`docs/experiments/evidence/installed-scheduler-backpressure-b94a80e/`.

## What this does not prove

This is one count-bound fan-in path. It does not yet prove every byte-bound,
fan-out, self-loop, crash-recovery, or dynamic-limit case in a real Linux
process pipeline; those remain covered only at lower layers. It also does not
prove periodic scheduling, external-effect recovery, tool/model capability
composition, or public bootstrap support.

`openDollyRuntime` remains closed for configured Modules with
`RUNTIME_MODULE_MIGRATION_REQUIRED`.
