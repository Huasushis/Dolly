# Installed Source Module vertical-slice result

Date: 2026-08-12 UTC

Source: `94848f6367377ac063539b155664bfac9bfe5e1a`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can the candidate installed composition accept one durable, manually submitted
Source request, let the same Scheduler select it, execute the installed
Extension in a delegated Linux control group, persist its output, prove the
whole process group stopped, and recover the result after reopening Core state?

The counterexample is a Source queue, Scheduler, installed package, Linux
executor, or result journal that passes separately but is not connected to the
same durable request and process identity.

## Result

The exact Linux integration passed 2/2 tests. The Source case installed a
`dolly.extension-package/3` package, submitted one request to the bounded
`SourceActivationQueue`, and observed `requestStatus="enqueued"` followed by
the Scheduler decision `READY_SOURCE`. The real Extension process executed
exactly once and committed exactly one Module result. Reopening Core state
recovered `source:1:run-1`.

The process record reached `stopped`, its exact Module control group was
removed, and the disposable runner removed only the recorded container and
image `dolly-experiment-2582754-13ed42af` and
`dolly-experiment-2582754-13ed42af-image`. Exact post-run inspection found both
absent.

The same run also revalidated the three-process resident-mailbox path. The
Scheduler held the second producer before dispatch while the drainer owned the
only resident slot, then resumed it after capacity returned. Producer Run
counts were `2/1` before release and `2/2` after release; six Module results
were committed, the unknown shutdown outcome kept its Claim active, all three
process records reached `stopped`, and all three exact control groups were
removed.

The retained local transcript is
`artifacts/experiments/linux-core-service-ownership/container-2582754-20260812T085526Z/linux-integration.log`
with SHA-256
`484dc8e8c05b3c2f039ac7a9b1e37b486edf0ceda63187161e047b17781d896d`.
The tracked source archive contained commit `94848f6`; `.env`, Git metadata,
owner checkout files, and writable dependencies were absent from the
container.

## What this does not prove

This is a candidate vertical slice invoked below public bootstrap. It proves
one manual Source request, not an automatic periodic producer, an external
network listener, persistent source-request history retention, dynamic
configuration, model/tool capability composition, Memory, cycle progress, or
cross-platform process ownership. The Source limits are still supplied at the
candidate composition boundary rather than persisted in the public instance
schema.

`openDollyRuntime` therefore continues to reject every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This evidence supports the Source
composition and Scheduler path; it is not authorization to remove that safety
condition.
