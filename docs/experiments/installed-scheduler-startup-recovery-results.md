# Installed Scheduler startup-capacity recovery result

Date: 2026-08-12 UTC

Source: `495b1b19b2724ca377077ff9e37bfba9e88f65ea`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

After restart, can Dolly preserve an already generated Module result whose
output is blocked by a full downstream mailbox, let a different installed
Module release that capacity, and commit the old result without starting the
old producer again?

This is stricter than recovering two prepared journals where one journal alone
can release the other. Here the needed capacity is released only by a new Run
of the downstream installed Extension under the shared Scheduler.

## Result

The exact Linux integration test passed. Before startup, the file-backed Core
contained an active producer Claim, its matching submission, a prepared result
journal, and a full one-slot downstream mailbox. Its old producer process
record was terminal. Startup then:

1. independently proved that the exact old producer control group was absent;
2. revalidated the Claim, submission, result journal, and output capacity;
3. transferred the deferred commit through the one-use startup-recovery
   handoff into the installed host;
4. reported the host as `recovering`, without allocating or starting a new
   producer process;
5. started only the real downstream drainer Extension in its delegated Linux
   control group;
6. used the shared Scheduler to commit the old producer result after the
   drainer freed capacity; and
7. dispatched the drainer once more to consume that restored output.

The producer executor ran zero times. The drainer ran twice. All three result
records were committed. Reopening the Core and journal files preserved the old
producer Claim as committed, both process records as stopped, and the restored
output effects. Orderly shutdown removed the drainer's exact control group.

The same container run passed all 5 installed-host cases, including strict
streaming Agent, Source, periodic, and live backpressure coverage. The runner
created only the recorded container
`dolly-experiment-2762144-c359fb81`; exact post-run inspection returned absent.

The retained local transcript is
`artifacts/experiments/linux-core-service-ownership/container-2762144-20260812T103643Z/linux-integration.log`
with SHA-256
`fc7d6019cd0eb8ba8a8a75d05ac2df73179d5335514d61f1aca323b849cff5c1`.
The environment and preflight files have SHA-256
`4c66ed875461b8796fc11fdb7f45f40d4d34a120b081b8afa1e6977bd942d3d5`
and
`ecf7fce3780e2b756cfc847409343f9dc3196b8e6f9da072679da4c713411c36`.

## Falsifying attempts retained

The first version trusted the persisted `stopped` label without giving startup
a fresh Linux stop prover. Core rejected it before composition. That failure
changed the test: the passing version now requires an independent proof that
the exact old Module control group is empty.

The next version paired a manifest identity with a child fixture declaring a
different Extension identity. The Extension Host rejected initialization. The
passing version makes the verified installation and child identity identical;
the Host check was not weakened.

## What this does not prove

The candidate host still does not own public ingress while it is `recovering`.
A valid Delivery state permits at most one active job, and therefore at most
one deferred prepared result, for each Module; separate conformance mutations
cover rejection of a second live Claim and a restarted snapshot with two active
jobs for the same consumer. This Linux case does not prove dynamic mailbox
limit changes, recovery of unknown external effects, or Windows/macOS process
ownership. It uses the installed process boundary but no paid or network model
call.

`openDollyRuntime` continues to reject every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. This result closes one product-before-
bootstrap restart counterexample; it is not authorization to remove that
safety condition.
