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

## What this does not prove

This result does not prove that configured Modules are product-supported.
`openDollyRuntime` still refuses every configured Module with
`RUNTIME_MODULE_MIGRATION_REQUIRED`. The test directly constructs one executor;
it does not yet prove Scheduler assembly, Page ingress wake-up, runtime
replacement after a hard timeout, durable external-effect recovery, product
shutdown ordering, Windows support, or macOS support. Those remain separate
gates before the startup refusal can be reconsidered.
