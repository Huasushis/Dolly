# ADR-0010: Host-internal configuration-value upgrade chain

Status: Proposed

Date: 2026-08-14

## Context

`src/core/config-revision.ts` implements an immutable configuration
**revision** and a deterministic **configuration-value upgrade chain**:
one-step upgrade paths from a configuration version (`configVersion`) vN to
vN+1, applied to an immutable `ConfigRevision` and producing a new
content-addressed revision. No imported Dolly specification normatively
defines such a chain. In particular,
`dolly-spec/docs/spec/extension-protocol/04-hot-reload-and-state-migration.md`
Section 5 ("Migration") normatively governs `module.migrate_state`, the
Extension-side migration of staged **snapshot state** (an immutable
`SnapshotEnvelope` in `extension-lifecycle-rpc.schema.json`) from one
state-schema version to another under Host authority; it says nothing about
upgrading a configuration value from one `configVersion` to the next. Earlier
code documented the runner as "the config-value side" of that Section 5
contract, which was a false normative attribution: the loss classes, the
configured approval identity, the output-size and expansion limits, and the
one-step paths in `config-revision.ts` are a Host-internal design, not
imported-spec rules.

This ADR records that design explicitly as a Host-internal contract so future
Store, Host, or console wiring can rely on one named, concrete definition
without claiming imported-spec authority.

## Proposed decision

The **configuration-value upgrade chain** is a Host-internal contract: the
deterministic, side-effect-free sequence of one-step configuration upgrades
from a source `configVersion` to a higher target version, defined here and
implemented by the pure configuration-value support in `src/core/config-revision.ts`.

Concrete objects and actions:

- A **configuration revision** (`ConfigRevision`) is a deeply frozen record
  binding a content-addressed `revision` (SHA-256 of the canonical JSON record
  body) to the identity fields `configId`, `extensionId`, `moduleKind`, an
  integer `configVersion`, and a frozen `configuration` JSON snapshot with its
  own canonical `configurationDigest`. Equal inputs produce the same revision;
  an edit always creates a new revision and never overwrites the previous pair.
- An **upgrade path** is a chain of registered one-step migrations, each from
  `fromVersion` to `fromVersion + 1` with a stable `operationId`, a closed
  loss declaration (`none | value-loss | synthesis | semantic-change`), an
  `approvalRequired` flag, and a deterministic `migrate` step.
- The **runner** (`ConfigMigrationRunner`) applies the chain to a source
  revision: it validates the source against its retained schema, runs each
  step, validates each result against its target schema, aggregates warnings,
  caps the result by canonical output-size and expansion limits, and returns a
  new content-addressed revision together with the ordered `appliedOperations`
  (the idempotency key of the chain).
- **Approval**: a step that is not declared `none` MUST require approval. A
  step skips the approval gate only when its `operationId` is already present
  in `alreadyApplied` (idempotent replay); otherwise a matching approval by
  operation id or by the runner's configured approval identity is required,
  and a loss-declaring step without it refuses the whole upgrade. Silent lossy
  migration is forbidden.
- The chain MUST run on the immutable source revision and never against the
  sole active value; it never mutates its inputs and performs no I/O.

Relation to Dolly configuration revisions: this ADR is the authority for how a
`ConfigRevision` in `config-revision.ts` changes version without user
re-entry. `configVersion` is a Host-owned configuration-schema version. It is
distinct from the Extension's advertised **state** schema version
(`state_schema_version`) used by `module.migrate_state`, and distinct from the
process-lifecycle identity (`extension_generation`, `worker_epoch`) in
`02-lifecycle-and-fencing.md`. Persisting an upgraded revision as a store
record (`migrateModuleConfigurationRecord` in
`src/core/module-configuration-store.ts`) is a separate consumer of this
contract.

Why `module.prepare_config`/`module.commit_config` and `module.migrate_state`
are different and do not cover this chain:

- `module.prepare_config`, `module.commit_config`, and `module.abort_config`
  (04 Section 3) are the Extension-facing wire methods that make a frozen
  effective configuration current across a Host-triggered configuration
  transaction. They transport and commit final configuration bytes and do not
  define any one-step value upgrade path, loss classes, or version chain; this
  chain produces the upgraded value before any prepare/commit transaction
  would carry it.
- `module.migrate_state` (04 Section 5) migrates Extension-owned snapshot
  state (an immutable `SnapshotEnvelope`) between state-schema versions under
  Host authority; it says nothing about configuration values. Using it for a
  configuration value would misclassify a configuration change as a state
  mutation and cross the authority separation the wire protocol draws between
  Host-owned configuration and Extension-owned state.
- Generation replacement (04 Section 6) is the process/cutover sequence; it
  may consume migration results but does not define a configuration-value
  upgrade chain.

Invariants:

- `INV-CFG-001` — Deterministic: identical source revision bytes, parameters,
  and step registrations produce an identical target revision.
- `INV-CFG-002` — Immutable: a `(configId, revision)` pair is never
  overwritten or mutated; the chain never destroys the source revision or the
  active value.
- `INV-CFG-003` — Idempotent replay by operation id: a step whose
  `operationId` is already applied produces the same target revision without
  re-approval; an `alreadyApplied` id outside the current path refuses the
  upgrade.
- `INV-CFG-004` — No silent lossy migration: a loss-declaring step must be
  approved before applying, and a dropped/synthesized/semantically changed
  value without a declared loss class is a registration error.
- `INV-CFG-005` — Bounded and validated: every step result is validated
  against its target retained schema before the next step, and the final
  result respects the output-size and expansion limits.
- `INV-CFG-006` — Side-effect free: the chain never runs against the sole
  active value and performs no externally visible side effects.

Failure boundaries:

- An unsupported source version, a target with no retained schema or
  registered step, a target not higher than the source, a step output that
  fails its target schema, a missing approval, or a result over the
  output-size/expansion limits refuses the entire chain with a stable
  `ConfigRevisionError` code; a broken chain is detected before any step runs,
  and nothing is mutated.
- Transport, durability, retry, and operator-approval persistence are outside
  this ADR; they belong to Store/Host wiring that consumes this contract, not
  to the chain itself.

Non-authority while Proposed: this document is `Proposed`. While its status is
`Proposed` it is not normative and implementation must not claim conformance
to it for this chain, nor may any imported specification be cited as governing
it. Per `docs/adr/README.md`, this ADR may become `Accepted` only after its
affected contracts, migration impact, failure modes, and conformance tests
have been reviewed together.

## Consequences

The false normative attribution in `config-revision.ts` (citations of
extension-protocol 04 Section 5 as the authority for a configuration-value
chain) is replaced by an explicit Host-internal contract. Store/Host wiring
gains one named definition for the chain, and `migrateModuleConfigurationRecord`
can be described as the bridge onto that contract. The runner and its tests
behave exactly as before; only the documented authority changes.

## Required conformance evidence

- deterministic identical-target reproduction for equal inputs;
- idempotent replay by operation id without re-approval, and rejection of an
  out-of-path already-applied id;
- approval refusal for loss-declaring steps and registration rejection of
  silent lossy migrations;
- per-step target-schema validation and byte/expansion-limit refusal; and
- proof that the source revision and active value are never mutated.