# Installed Scheduler Module vertical-slice result

Date: 2026-08-10 UTC

Source: `ad6f42db38e9dd5e2022008e251c6669e592c698`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can one Scheduler use a persistent Page arrival to wake an installed,
process-isolated reactive Module, commit its output through the same persistent
Core state, stop the whole Linux control group, and recover the result after
reopening the files?

The counterexample is a superficially assembled system in which the Scheduler,
installation registry, Extension process, Delivery store, result journal, or
process record each passes a component test but no arrival drives the complete
chain.

## Result

The exact Linux integration test passed 1/1. It first observed an ineligible
Scheduler decision with an empty input Page. Only then did it append one input
to the persistent Delivery store. Although the configured polling interval was
60 seconds, the change notification drove the Module and satisfied the
5-second completion criterion; the complete test body took 802 ms.

The process ran the managed package digest
`sha256:33baac74475b868d235f7d21c2a25b555f5ac3ebc2be1503b7f2cacf6b7b5e40`
after its source package directory had been deleted. The Scheduler observed a
`committed` tick, the sink Page received one Delivery, and reopening both the
Core state and result journal recovered the output `scheduled:1`. Orderly stop
wrote the process record as `stopped` and removed the exact Module control
group.

The run used a verified user-service binding with `Linger=yes`, a delegated
control-group version 2 root, and the `cpu`, `memory`, and `pids` controllers.
The tracked source and dependencies were read-only; `.env`, `.git`, and owner
checkout files were absent. The runner removed only its exact container
`dolly-experiment-940851-e19037cb`; a post-run inspect found it absent.

Evidence is in
`docs/experiments/evidence/installed-scheduler-module-ad6f42d/`.

## What this does not prove

This is one reactive, effect-free Module, not yet the complete general Agent.
It does not prove multi-Module fairness, periodic activation, dynamic
configuration, model or tool capabilities, persistent external-effect
recovery, task Memory, Windows or macOS process ownership, or recovery from a
crash during an active Run. Instance schema version 9 also cannot persist the
new Scheduler and Linux constraints.

`openDollyRuntime` therefore continues to refuse every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This evidence closes the previously
missing single-Module Scheduler assembly only; it is not authorization to
remove that refusal.
