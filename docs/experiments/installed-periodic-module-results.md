# Installed non-empty periodic Module vertical-slice result

Date: 2026-08-12 UTC

Source: `57650023fdd10d1bce4f0356931f1cb1e9dfcc98`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can an integrity-checked installed package declare a delivery-backed periodic
Module, and can the same Scheduler prevent a second real process Run before the
configured start-to-start period while still waking it at the known deadline
without relying on a coarse poll?

The counterexample is important because the Scheduler component previously
passed fake-clock periodic tests while installed composition rejected periodic
packages. The first real Linux attempt then exposed a second gap: after
correctly refusing early execution, Scheduler had no timer for the known
`nextEligibleAt` and waited for the 60-second liveness poll.

## Result

Package schema `dolly.extension-package/4` retains the version-3 content-schema
and source shape and adds only the declaration `activation: "periodic"`. The
candidate installed composition accepts it only with a non-empty input route
and `allowEmptyInput: false`; it adds no background Extension protocol or
capability.

The Scheduler now keeps one shared timer for the earliest known policy, retry,
or period deadline. The exact Linux integration used a 60-second poll and a
750ms period. Two durable inputs produced two `READY_PERIODIC` dispatches. The
measured start-to-start interval was 750.590242ms, so no second Run began early.
The before-deadline pass remained ineligible, and both results became durable
commits. The real installed process ended with a `stopped` record and its exact
Module control group was removed.

The same disposable run also revalidated the resident-mailbox pipeline and the
manual Source vertical slice, for 3/3 passing tests. The runner removed only
its recorded container and image, `dolly-experiment-2649216-51fbba76` and
`dolly-experiment-2649216-51fbba76-image`; exact post-run inspection found both
absent.

The retained local transcript is
`artifacts/experiments/linux-core-service-ownership/container-2649216-20260812T091232Z/linux-integration.log`
with SHA-256
`0e549cc1b69a016559a2789f4f384f9b13335274e7f76438ff22975419d8cfeb`.
The tracked source archive contained commit `5765002`; `.env`, Git metadata,
owner checkout files, and writable dependencies were absent from the
container.

## What this does not prove

This is non-empty periodic execution over durable input. It does not support an
empty-input timer Run, an automatic periodic Source producer, dynamic period
changes, adaptive period selection, missed-period behavior across process or
Core restart, or cross-platform process ownership. Package version 4 grants no
capability. The public instance schema still does not persist the complete
Scheduler/Linux composition constraints.

`openDollyRuntime` continues to reject every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This evidence closes a candidate
Scheduler/installed-process effect; it is not authorization to remove that
safety condition.
