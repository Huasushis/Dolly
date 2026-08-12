# Installed Linux Extension Module vertical-slice result

Date: 2026-08-10 UTC

Source: `51a696244d528ccbbeb731865fa037bff6d6c86d`

Environment: uniquely named disposable Ubuntu 24.04 systemd container

## Question

Can the product-before-bootstrap Linux executor start the exact Node.js bytes
returned by the installation registry, use the configuration record validated
against that package's schema, bind the Module generation and durable Run
submission to the same process generation, and then prove whole-group stop?

The counterexample was the previously legal composition of process record A,
executable B, manifest C, and configuration D. Component tests for those four
objects do not show that one runtime uses the same provenance.

## Result

The exact Linux integration file passed 2/2 tests. In the new installed-package
case:

- the source package directory was deleted after managed installation and
  before executor start;
- the process record stored the managed package digest
  `sha256:e5ab0e523283fc243a15ac9f7ad3730fe538ebefe60a1c87611fa43e97d2548a`;
- the child completed the Extension protocol from the managed absolute
  entrypoint;
- the durable Run submission used the generation factory's exact process
  generation;
- the process record reached `stopped`, the Module control group was removed,
  and the exact observed process identity no longer existed.

The run used a verified user-service binding with `Linger=yes`, a delegated
control-group version 2 root, and the `cpu`, `memory`, and `pids` controllers.
The tracked source and dependencies were read-only; `.env`, `.git`, and owner
checkout files were absent. The runner removed only its exact container
`dolly-experiment-927494-f1f35b30`; a post-run inspect found it absent.

Evidence is in
`docs/experiments/evidence/installed-linux-extension-module-51a6962/`.

## Extension process session follow-up

On 2026-08-12 UTC, source
`342d42f3c795fa9dec0635554d3df27377ad16bd` added a read-only lookup from the
installed generation factory to the exact `ExtensionProcessHost` session it
created. The focused Linux integration again passed 2/2 tests in the uniquely
named disposable container `dolly-experiment-3472093-63cc83b2`.

The new assertions established that:

- a process generation has no session before its executor starts;
- after the exact installed process is ready, the returned identity matches
  the installed extension, instance, Module, Module generation, and process
  generation;
- an unknown process generation returns no session; and
- after whole-group stop, durable `stopped`, control-group removal, and exact
  process disappearance, the former process generation again returns no
  session.

The runner removed only that exact container; a post-run inspect found it
absent. Reproducible metadata and a plain result summary are in
`docs/experiments/evidence/installed-linux-extension-session-342d42f/`. The
raw local runner log SHA-256 was
`44791448f18ff3af2cafc99c1cc60c68a82c00a338da244812ca530eb3710813`.

Source `96a52ce04e67f17dd9267f86e6c13060375c2aaa` then composed that
lookup with `createFileCoreActiveRunModelMediaResolver` in the same real Linux
test. Before executing the installed fixture, the resolver required the exact
active Claim, matching durable submission, running process record, live Host
session, and a Media reference delivered in that Claim. It returned the
verified inline PNG copy and left zero Media leases. After whole-group stop,
the identical request was refused. The focused file again passed 2/2 tests in
the uniquely named disposable container `dolly-experiment-3474702-98964c3b`,
which the runner removed by exact name. Its raw local log SHA-256 was
`5e3e32e04d2f218f643d7124a801a206c083b8bde1b23d4d34a62a33a62417e4`;
the portable summary is in
`docs/experiments/evidence/installed-active-run-media-96a52ce/`.

## What this does not prove

This result does not prove that configured Modules are product-supported.
`openDollyRuntime` still refuses every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. The test directly constructs one executor;
it does not yet prove Scheduler assembly, Page ingress wake-up, runtime
replacement after a hard timeout, durable external-effect recovery, product
shutdown ordering, Windows support, or macOS support. Those remain separate
gates before the startup refusal can be reconsidered.
