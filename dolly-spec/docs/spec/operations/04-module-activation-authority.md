# Installed Linux Module activation authority

Status: normative for the Dolly v1 installed Linux Module startup boundary. This
chapter specifies prerequisites and refusal behavior; it does not enable a
currently guarded product path.
An **installed Linux Module** in this chapter is an installed Module whose
validated execution record selects the Linux process backend. It is narrower
than the platform-neutral Module abstraction. Another operating system requires
a separately versioned backend and ownership proof; it never interprets this
Linux record as portable process authority.

`REQ-ACT-002` — An installed Linux Module that references a permission policy MUST
resolve one exact persistent Host permission-policy definition and one exact
persistent Host backend-binding record before the Host creates a capability,
process generation, or Extension process. The records and the complete active
premise set MUST conform to
[`module-activation-premises.schema.json`](../../../schemas/module-activation-premises.schema.json).

## 1. Premises and authority direction

A **Module activation premise record** is the final persistent, non-secret
prerequisite set that an installed Host must verify before it may create live
Module execution authority. It binds one exact Runtime authority database
configuration mapping to exact permission-policy definition records,
permission-policy backend-binding records, installed-component origins, and
one Linux service candidate. It is called a premise record because its
canonical JSON bytes are inputs to Host verification, not a capability, service
proof, process handle, or permission.

Authority flows only in this direction:

```text
active configuration revision
  -> persistent permission-policy definition
  -> persistent Host backend-binding record
  -> fresh branded live backend binding

installed-product service candidate
  -> live service/runtime/delegated-root verification
  -> fresh branded Linux activation permission and runtime binding

controller lock + current configuration + activation permission
  -> startup recovery
  -> one-use recovery handoff
  -> installed composition
  -> fresh Module/process generations
  -> Ready / dispatch / result / commit / acknowledgement observations
```

Every arrow consumes and verifies its upstream premise. No arrow is reversible.
A persistent record is evidence to repeat Host verification after restart; it
is never serialized live authority.

## 2. Persistent permission-policy records

A permission-policy definition contains operator-approved operation semantics,
limits, and compatibility constraints. Its `definition` MUST validate against
the exact installed closed schema named by `definition_schema_uri` and
`definition_schema_digest`. That closed schema MUST reject secrets, secret
references, filesystem paths, endpoint handles, executable templates, source
code, function names, callable values, object handles, and capability tokens.
A strategy or implementation identifier in a policy is descriptive selection
metadata only; it is not executable code or authority.
The schema URI is only an identifier in the verified installed schema registry.
Startup MUST NOT fetch it from a network location or reinterpret it as a
filesystem path.

`definition_digest` is
`sha256(JCS(definition_record_without_definition_digest))`. A change to any
field, including the policy origin or definition schema, requires a greater
`policy_revision` and a new digest. Reusing a revision with different canonical
bytes is `MODULE_ACTIVATION_PREMISES_INVALID`.

A permission-policy backend-binding record connects exactly one definition
triple `(policy_id, policy_revision, policy_definition_digest)` to an installed
Host component. It contains only `binding_id`, monotonic `binding_revision`,
`binding_digest`, that definition triple, and the installed-product component
origin. Its closed record schema is
`dolly.permission-policy-backend-binding/v1`. `binding_digest` is
`sha256(JCS(binding_record_without_binding_digest))`. The origin's component
identifier, revision, and digest MUST identify one component in the verified
installed release. A component label supplied by configuration, an Extension,
an environment variable, a command-line option, a process record, or a test
factory does not satisfy that lookup.

The record MUST NOT serialize a credential, secret reference, endpoint,
filesystem path, repository object, function, factory, broker, tool executor,
storage backend, or generic network/file operation. Those remain private live
Host dependencies. Their selection or authority change requires a new binding
revision and digest even when the policy definition is unchanged.

The Host registry resolves an exact valid binding record to one freshly minted,
object-identity-branded live backend binding for the current controller
generation. The live binding freezes the complete definition and binding
identity, active configuration revision and digest, instance, and installed
component origin. A copied structural object, deserialized record, stale live
binding, caller-supplied function, or same-label component is rejected with
`MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE`.

The cardinality is exact:

- each distinct configured policy reference resolves to exactly one definition
  record and exactly one backend-binding record;
- each backend-binding record names exactly one definition triple;
- several Modules MAY reference the same immutable definition and binding
  records, but each controller generation resolves them once to its own fresh
  live binding and mints Module/session-scoped capabilities separately; and
- extra, duplicate, stale, or unreferenced records in an active premise record
  are invalid rather than additional authority.

The arrays are in ascending Unicode scalar-value order by `policy_id`, then
revision, and are unique by those identity fields. The set of definition
triples MUST equal the set selected by the active configuration. The
backend-binding array MUST contain exactly one matching row for each member of
that set.

## 3. Product-owned Linux service candidate

`REQ-ACT-003` — The installed Linux product MUST supply exactly one service
candidate from its verified installed-product component record. The closed
candidate record includes that origin, `unit_name`, `mode`, and
`candidate_digest =
sha256(JCS(candidate_record_without_candidate_digest))`. The candidate fields
are non-secret lookup inputs only. A Module, Extension, instance source
document, process record, environment value, command-line argument, Ready
response, or saved process identifier MUST NOT create or alter the candidate
used by product activation.

Dolly v1 installed activation accepts only `mode: "user"`, matching the
per-user daemon and systemd user-unit deployment contract. A lower-level probe
MAY inspect a system service, but `mode: "system"` is outside the v1 product
profile and cannot mint product activation permission. Foreground operation has
no restart-safe Linux service candidate and refuses executable Modules.

On Linux, the Host uses the candidate only to query the real service manager and
process filesystem. It MUST prove both directions of current process-to-unit
identity, effective service settings, current invocation and boot identities,
cgroup version 2 delegation, required controllers, and the reviewed executable
runtime profile. It then verifies that the delegated root has no process,
enables `cpu`, `memory`, and `pids`, and reads the enabled set back. The service
proof precedes delegated-root preparation; no candidate field or prior record
may stand in for either observation.

Only that successful live operation may mint one object-identity-branded Linux
Module activation permission for the current controller generation. The
permission contains the verified service binding, prepared delegated-root
snapshot, stop prover, and one branded runtime binding whose revision and digest
cover the reviewed runtime audit profile and candidate origin. Neither object
is JSON, survives restart, or can be reconstructed from equal fields.

The persistent definition, backend-binding, installed-component-origin,
service-candidate, and premise records use the closed definitions in
[`runtime-authority-record.schema.json`](../../../schemas/runtime-authority-record.schema.json).
They are logical tables in the one Runtime authority database, with the exact
foreign keys and cardinality in
[Storage and Recovery](../core/06-storage-and-recovery.md#31-runtime-authority-database-schema-version-1).
A digest has no global uniqueness or authority. No record serializes a live
backend object, capability, function, endpoint credential, secret, filesystem
path, activation permission, runtime binding, stop prover, or recovery handoff.

During a changed-config transaction, installed-component origins, definitions,
backend bindings, service candidate, and policy-selection rows are inserted or
verified first. The complete premise row is the last prerequisite inserted;
only the current config pointer and journal event follow it before the one
commit. Failure or crash before commit yields zero new persistent or live
authority.

## 4. Required startup order

`REQ-ACT-004` — After read-only inspection of the current authority-database
configuration identifies at least one installed Linux Module, writable product
startup MUST perform the following order. The **instance controller lock**
below is the one exclusive operating-system instance lock required by Core
storage, not a second lock with a different ownership domain.

1. Locate candidate database bytes from deployment configuration and inspect
   the closed authority state/current config read-only. This grants no
   ownership; a filesystem path is not authority.
2. Observe the Host platform through the zero-argument Host adapter. A
   non-Linux Host returns `MODULE_ACTIVATION_PLATFORM_UNSUPPORTED` before
   creating or acquiring a controller lock, opening writable Core storage,
   querying systemd, preparing a cgroup, recovering state, or creating a
   process.
3. Acquire exclusive controller-lock ownership for the exact
   `(daemon_installation_id, instance_id)` and mint a fresh controller
   generation. No live object from a previous owner is accepted.
4. Under that lock, open the same Runtime authority database with the required
   PRAGMAs and validate SQLite attestation, schema/migration version, integrity,
   foreign keys, database identity, bounds, current pointer, and exact canonical
   config bytes/digest. The reread must match the inspected revision/digest; a
   change refuses startup rather than silently substituting a revision. Do not
   yet recover work or expose runnable state.
5. Load the one premise record for that exact configuration revision, recompute
   every definition, backend-binding, origin, service-candidate, and premise
   digest, enforce all foreign keys and exact cardinalities, and resolve fresh
   live backend bindings. This step starts no Extension and grants no
   capability.
6. Verify the product-owned service candidate and reviewed runtime, then
   prepare and read back the delegated root. Only now mint the activation
   permission, runtime binding, and stop prover for this controller generation.
7. Prove every old Module execution container empty using the exact stop
   prover, then perform startup recovery in the Storage and Recovery order.
8. After all old-process, result, Claim, cursor, counter, and generation
   reconciliation succeeds, mint one opaque recovery handoff. It is one-use and
   bound to the controller generation, exact Runtime database, result
   repository, configuration and premise digests, activation permission, and
   stop prover.
9. Installed composition consumes that exact handoff, activation permission,
   runtime binding, and policy backend bindings. Only this step may create the
   installed Host, fresh Module generations, and non-reused process
   generations.
10. Expose `Ready` and admit Activation work only after composition and all
    recovered commit-only work required by the readiness contract complete.

Any failure unwinds resources created after the lock and releases the lock only
after writable stores and live bindings are closed. It never advances to a
later step to obtain evidence that an earlier step lacked.

## 5. Restart, revision, and migration

`REQ-ACT-005` — Restart and migration MUST preserve the premise direction and
must not infer missing upstream authority.

A normal restart reuses verified persistent record bytes only after digest and
current-revision checks. It always creates a new controller generation, new
live backend bindings, new activation permission and runtime binding, and a new
one-use recovery handoff. Old object identities are stale even when every
persistent digest is unchanged. Module and process generations remain distinct:
composition may preserve the logical Module but allocates every replacement
process generation once and never reuses it.

A definition, backend binding, installed component, service candidate, or
active configuration change changes the complete canonical resolved
configuration digest and creates a new config mapping plus complete premise in
the same authority transaction. It requires quiescence and a new
Module/process generation where the changed premise can affect execution. A
current change never upgrades an existing Activation Manifest or authorizes a
stale process generation.

Migration is an offline operation under the exact instance controller lock
against an explicitly expected source identity and revision. Legacy JSON is
validated and normalized, and its complete resolved JCS bytes and digest are
computed before the schema-version-1 SQLite transaction starts. That transaction
inserts all prerequisite records, inserts the premise last, and publishes the
mapping/current pointer once. A crash before commit leaves no new authority; a
crash after commit leaves SQLite as the sole authority even if the JSON remains
on disk. Startup never chooses between JSON and SQLite. A legacy policy
identifier, in-memory registry entry, process record, successful result,
acknowledgement, or absent record MUST NOT supply a missing definition,
backend binding, revision, digest, or origin. An unresolved legacy policy
remains blocked as `MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE`; migration
neither creates a live binding nor mints a recovery handoff. Normal startup must
rerun all ten steps after migration.

## 6. Downstream abstention and invariants

Ready, process creation or exit, a process record, protocol authentication,
result bytes or digest, commit, positive or negative acknowledgement, timeout,
absence, and status response are downstream observations. They may fence or
classify work under their own contracts. They MUST NOT create a configuration
claim, policy definition, backend binding, service candidate, activation
permission, runtime binding, stop prover, or recovery handoff.

- **INV-ACTIVATION-012 — Premise direction.** Every installed Linux Module capability
  and process generation has one complete path to the current configuration,
  exact definition/binding records, installed-product origins, fresh controller
  generation, activation permission, and consumed recovery handoff; no edge
  points from a downstream observation to an upstream premise.
- **INV-ACTIVATION-013 — Exact cardinality.** One active configuration revision
  has one premise record and service candidate, one definition and binding per
  distinct configured policy reference, one fresh live binding per distinct
  binding and controller generation, one activation permission, and one
  one-use recovery handoff.
- **INV-ACTIVATION-014 — Revision and generation continuity.** Digests verify
  canonical bytes, revisions never name different bytes, restart changes every
  live authority generation, and migration installs a complete new premise set
  without relabeling legacy evidence.
- **INV-ACTIVATION-015 — No downstream manufacture.** Ready, process, result,
  commit, acknowledgement, status, timeout, and absence evidence never grants or
  reconstructs configuration, policy, service, or recovery authority.

The mandatory vectors
[`TST-AUTH-001`](../../../test-vectors/core/TST-AUTH-001-policy-binding-origin.json),
[`TST-AUTH-002`](../../../test-vectors/core/TST-AUTH-002-startup-order.json),
[`TST-AUTH-003`](../../../test-vectors/core/TST-AUTH-003-restart-migration-abstention.json),
[`TST-AUTH-004`](../../../test-vectors/core/TST-AUTH-004-config-revision-transaction-crash.json),
[`TST-AUTH-005`](../../../test-vectors/core/TST-AUTH-005-reopen-identity-digest.json),
and
[`TST-AUTH-006`](../../../test-vectors/core/TST-AUTH-006-stale-pointer-cross-origin.json)
are the minimum conformance cases. Implementations MUST additionally test every
transaction/startup boundary by crash injection and reject unknown fields,
duplicate records, digest/content mismatch, stale revision or pointer,
cross-policy binding, copied brand, stale controller generation, non-product or
cross-installation origin, and wrong service mode.

This contract alone does not authorize removal or weakening of the public
`RUNTIME_MODULE_MIGRATION_REQUIRED` refusal. It also does not claim that
`FileCoreStateStore`, a Module result journal, or any other file-backed Core
composition satisfies global aggregate boundedness or the normative SQLite
storage contract. Those are separate release gates.
