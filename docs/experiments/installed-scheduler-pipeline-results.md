# Installed Scheduler pipeline result

Date: 2026-08-10 UTC

Source: `fab383a6a1f735ca80f39230aa0bf56b7c00aed6`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can one Scheduler run more than a one-Module demonstration: specifically, can
an external input wake a first installed process, persist its output to an
intermediate Page, use that durable arrival to wake a second installed process,
and recover the final output after shutdown and reopen?

The counterexample before this change was deterministic: the installed host
composition rejected any configuration containing more than one Module.

## Result

The exact Linux integration test passed 1/1. It observed empty-input Scheduler
decisions for both Modules before appending the external input. With the normal
poll interval deliberately set to 60 seconds, the first persistent Page change
and the first Module's persistent intermediate output drove both executions
within the 5-second criterion. The complete test body took 901 ms.

Both Modules executed the managed package digest
`sha256:33baac74475b868d235f7d21c2a25b555f5ac3ebc2be1503b7f2cacf6b7b5e40`
in separate Linux control groups and used separate configuration records. The
result journal contained two committed Module results. Reopening the Core state
and journal recovered the final output `second:1`, with both input mailboxes
empty and one pending sink Delivery.

Orderly host stop wrote both process records as `stopped` and removed both
exact Module control groups. The runner removed only its exact container
`dolly-experiment-945707-2efeaadf`; a post-run inspect found it absent.

Evidence is in
`docs/experiments/evidence/installed-scheduler-pipeline-fab383a/`.

## What this does not prove

This is a two-stage, reactive, effect-free pipeline. It does not prove
fairness under competing branches, cycle progress, mailbox backpressure in a
live process pipeline, periodic activation, persistent external-effect
recovery, model/tool capability composition, dynamic configuration, Memory,
or cross-platform process ownership. It also does not run through the public
bootstrap because instance schema version 9 cannot persist the required
Scheduler and Linux constraints.

`openDollyRuntime` therefore still refuses configured Modules with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. The result supports the multi-Module
Scheduler assembly, not removal of that safety boundary.
