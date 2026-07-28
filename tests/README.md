# Dolly Test Projects

Tests are separated by authority and external effects. A credential being
present in `.env` never selects a live or paid test.

## Default tests

`npm test` uses `vitest.config.ts` and runs the supported conformance tests plus
the public software development kit (SDK) type boundary test. These tests cover
the current replacement core, media, process, security, provider, command-line
and package contracts. They MUST NOT connect to a non-loopback network endpoint,
use a private service, or make a paid call. Bounded loopback sockets and
inherited local inter-process communication MAY be used to exercise real
process-boundary behavior without external dependencies.

`npm run test:conformance` selects the contract tests under
`tests/conformance/`. These tests use injected IDs, clocks, executors, stores,
and failure controls. A passing replacement primitive does not close a takeover
defect until the production runtime is migrated and the traceability row's
remaining recovery cases pass.

## Legacy tests

`npm run test:legacy` uses `vitest.legacy.config.ts` to run the old in-process
orchestrator, Page, BlockManager, MediaManager, scheduler, and extension tests.
They are retained for migration diagnosis only. They do not validate the
supported runtime, are not release gates, and must not be used as evidence that
the removed public extension interface is safe. The old integration tests may
perform local file work and use test doubles; they are still not live-provider
tests.

## Live project

`npm run test:live` uses `vitest.live.config.ts`. Every current live case is
also potentially paid, so it runs only when all of the following are true:

- `RUN_LIVE_INTEGRATION=1`;
- `RUN_PAID_INTEGRATION=1`; and
- the named fixture's credentials and endpoint configuration are present.

Without both opt-in flags the files load only far enough to report skipped
tests. A key, endpoint, descriptor, or `.env` file alone does not activate a
call. Live results are adapter evidence; they cannot replace deterministic
conformance.

## Experiments

Programs under `test/experiments` and `test/memory-experiments` are not part of
either Vitest project. They remain historical or research material until they
have a preregistered manifest, fixed data split, budgets, raw artifacts, and the
gates required by `docs/experiments/protocol.md`.
