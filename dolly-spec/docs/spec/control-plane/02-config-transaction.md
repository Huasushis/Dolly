# Configuration Transaction Protocol

Status: normative for applying, aborting, recovering, and rolling back instance configuration.

## 1. Consistency model

A Dolly configuration update spans the Host database and potentially several Extension processes and Extension-owned stores. It is therefore not a single ACID transaction.

The control plane provides:

- one authoritative Host commit point;
- durable transaction intent and participant receipts;
- side-effect-free prepare;
- quiescence and generation fencing;
- idempotent commit/abort/restore operations; and
- explicit forward-recovery, rollback, and `Degraded` states.

An implementation **MUST NOT** report “atomic rollback” merely because it attempted compensating RPCs. If convergence to either the old or target configuration cannot be proven, the instance is `Degraded`.

Only one configuration transaction per instance MAY be in `Preparing` or a later nonterminal state. Additional proposals remain queued or return `revision_conflict`.

## 2. Durable transaction record

Before contacting a participant, the Host **MUST** persist a record containing:

- transaction and operation IDs;
- base config and graph revisions;
- target normalized configuration and digest;
- proposed target config and graph revision numbers;
- JSON Patch and redacted diff;
- affected participants and change classes;
- required approvals and obtained approvals;
- deadlines;
- state and transition sequence;
- participant prepare tokens, receipts, snapshots, and generations; and
- last error and recovery decision.

The full unredacted configuration remains protected instance data. Transaction diagnostics **MUST NOT** duplicate secret values.

## 3. State machine

The durable state machine is:

```text
Proposed -> Validating -> Validated -> Preparing -> Prepared
Prepared -> Quiescing -> Quiesced -> Applying -> CommitReady
CommitReady -> Committed -> Activating -> Complete

Proposed/Validating/Preparing/Prepared -> Aborting -> Aborted
Quiescing/Quiesced/Applying/CommitReady -> RollingBack -> RolledBack
Committed/Activating -> ForwardRecovering -> Complete
RollingBack/ForwardRecovering -> Degraded
```

`Aborted`, `RolledBack`, `Complete`, and `Degraded` are terminal for that transaction ID. Repair from `Degraded` uses a new repair operation linked to the failed transaction.

Every transition **MUST** be written before the next phase sends RPCs. Repeating a phase after crash **MUST** use its original operation and participant IDs.

## 4. Proposal, validation, and approval

A proposal **MUST** contain a base revision, JSON Patch, operation ID, principal, reason, expected impact, and rollback condition. Validation follows the configuration specification and is side-effect free.

Approval policy **MUST** classify at least:

- low-risk bounded Runtime settings that MAY be automatically approved;
- model, prompt, scheduling, and Extension settings that policy MAY auto-approve or require a user;
- topology, capability, package, destructive disposition, remote access, and sandbox weakening changes that require an authenticated administrator; and
- forbidden online changes.

An LLM or Extension MAY propose a patch only through `host.config.propose`. It **MUST NOT** approve its own elevated change or write the active file/store directly.

Approvals bind the exact target digest and expire according to policy. Any change to the patch or target requires new validation and approval.

## 5. Prepare

The Host calls each eligible in-generation Module participant's prepare method
with transaction ID, expected Extension generation, base/target revisions,
complete target effective configuration, its value/schema-bundle digests, the
complete prepare-input digest, and deadline. A change to the Extension-level
object or its schema binding uses generation replacement and initialize rather
than this Module-only prepare path. Prepare **MUST** satisfy the side-effect-free
contract in the Extension hot-reload specification.

Participants MAY prepare concurrently when independent. The Host **MUST** collect a durable receipt for every required participant before entering `Prepared`.

If any participant rejects, times out, exits, changes generation, or returns a mismatched digest, the Host enters `Aborting`. `module.abort_config` **MUST** be idempotent. Failure to clean temporary prepare data is an operational warning; evidence of active-state mutation during prepare is a conformance failure and MAY quarantine the Extension.

## 6. Quiesce and snapshot

After `Prepared`, the Host determines the quiescence-required subset using the
configuration specification. A graph-only change with fully retainable old
snapshots has an empty subset and MAY advance directly through `Quiescing` and
`Quiesced` without fencing existing Activations. For every participant in the
subset, the Host fences new work and waits for in-flight operations according
to their state machines.

If the quiesce deadline expires before required old work reaches a safe
boundary, the default is rollback before graph cutover. An administrator MAY
choose forceful cancellation only when every relevant operation is known to be
pre-commit or has a safe idempotent recovery path. The system **MUST NOT** infer
this from process termination alone.

Required snapshots **MUST** be completed and verified in `Quiesced`. Snapshot failure enters `RollingBack`. Old state and package bytes remain retained through the configured recovery window.

## 7. Participant apply and CommitReady

In `Applying`, the Host calls idempotent participant commit/apply methods using the prepare token and target digest. A participant MAY stage or activate local configuration required to serve the target revision, but while the Host has not reached its commit point it:

- **MUST** remain quiesced;
- **MUST NOT** publish Blocks, advance cursors, or send user-visible actions under the target revision;
- **MUST** record a receipt queryable by transaction ID; and
- **MUST** support documented restore/compensation from the verified snapshot where it claimed rollback support.

Only after every required receipt is durable **MAY** the Host enter `CommitReady`.

Failure during `Applying` enters `RollingBack`. Since apply **MAY** have changed participant-local state, rollback is compensating recovery rather than ACID abort.

## 8. Authoritative commit point

The authoritative commit point is the one `BEGIN IMMEDIATE` Runtime SQLite
transaction defined in
[Storage and Recovery](../core/06-storage-and-recovery.md#31-runtime-authority-database-schema-version-1).
It:

1. verifies the active base config/graph revisions and all required
   `CommitReady` receipts;
2. validates the complete canonical resolved configuration and digest;
3. reuses the current config revision only for exact current digest **and byte**
   equality, otherwise allocates the next integer and inserts its append-only
   mapping;
4. inserts or verifies every installed-component origin, permission-policy
   definition, backend binding, service candidate, and exact premise-selection
   row;
5. inserts the complete Module activation premise as the last prerequisite
   record;
6. advances graph revision when applicable, selects current Extension
   generations, updates the active graph/config pointers, and marks the
   configuration transaction `Committed`; and
7. appends the config-installed journal event and commits once.

Before this database transaction commits, the base revision is authoritative.
After it commits, the complete target revision is authoritative. Rollback
exposes no mapping, prerequisite, premise, pointer, or journal subset. A
same-content proposal that reuses the current revision may complete its
idempotent operation record but is not a semantic configuration change.

The Host **MUST** not unquiesce target Modules until it can reopen/read back the
committed mapping, current pointer, and complete premise set. Unquiescing occurs
in `Activating`. Failure after the commit point enters `ForwardRecovering`, not
ordinary abort.

## 9. Rollback before the commit point

Rollback attempts to restore the base revision using participant receipts and snapshots. Each step **MUST** be idempotent and journaled.

Rollback succeeds only when the Host proves that:

- the active Host revision remains the base revision;
- all affected old generations/state are restored or were never changed;
- no target-revision Activation or user-visible effect committed;
- all fences and routing point to the base graph; and
- health checks for the base revision pass.

Only then **MAY** the transaction become `RolledBack` and old work resume.

If a participant cannot be restored, a receipt is contradictory/missing after an indeterminate operation, rollback itself crashes repeatedly, or target effects escaped quiescence, the transaction and instance **MUST** become `Degraded`.

## 10. Recovery after the commit point

Once committed, recovery SHOULD converge forward:

- respawn the selected generation if necessary;
- replay idempotent restore/apply using transaction receipts;
- restore verified target snapshots;
- re-run health probes; and
- unquiesce only participants known to match the target digest.

An automatic reverse transaction MAY be proposed when the rollback condition fires, but it is a new revision and is allowed only if state compatibility and side-effect rules prove it safe. Revisions **MUST NOT** move backward.

If forward convergence fails and safe reverse migration cannot be proven, the instance remains `Degraded`. Unaffected Modules MAY continue only if isolation analysis recorded in the transaction proves they cannot reach affected state or routes.

## 11. Crash recovery rules

On startup the control plane **MUST** scan nonterminal transactions before accepting new configuration operations.

| Durable state | Required recovery |
| --- | --- |
| `Proposed`/`Validating` | resume validation or abort without participant calls |
| `Preparing`/`Prepared` | query matching generations; resume or abort prepare |
| `Quiescing`/`Quiesced` | restore fences, inspect operation commits, resume phase |
| `Applying`/`CommitReady` | query participant receipts; never blindly repeat unknown effects |
| `Committed`/`Activating` | target revision is authoritative; converge forward |
| `RollingBack` | resume compensation; mark `Degraded` if proof is unavailable |
| `ForwardRecovering` | continue target convergence or mark `Degraded` |

An absent process is not evidence that its last RPC had no effect. Durable receipts, snapshots, and idempotency status determine recovery.

## 12. Cancellation

User cancellation before `Preparing` aborts immediately. During prepare it requests participant abort. During quiesce/apply it is accepted only as a request to enter safe rollback. After the Host commit point, cancellation cannot erase the commit and instead creates or requests a reverse transaction.

The control plane **MUST** expose the resulting state; it MUST NOT return a generic “cancelled” status while compensation continues.

## 13. Degraded operation

`Degraded` status **MUST** include:

- authoritative Host revision and digest;
- uncertain or mismatched participants;
- last proven snapshots/receipts;
- fenced Modules and routes;
- safe read-only diagnostics;
- supported repair choices and their data-loss risk; and
- an immutable incident correlation ID.

The admin API **MUST NOT** offer a one-click “mark healthy” that bypasses state verification. An operator **MAY** choose forward repair, restore from verified backup, explicit destructive reset, or leave the affected set offline.

## 14. Conformance tests

Tests **MUST** kill the Worker and every participant before and after each durable phase write and each participant response. They **MUST** prove:

- prepare never mutates active state;
- the Host exposes only base or target revision, never a mixture;
- stale generations cannot escape quiescence;
- replay uses original operation IDs;
- post-commit failure converges forward;
- failed compensation results in `Degraded`; and
- no failure path reports false rollback success.

## 15. Stable requirements and invariants

- `INV-CTXN-001` — The active configuration visible to clients is entirely the base revision before the Host commit point and entirely the target revision after it.
- `INV-CTXN-002` — A participant cannot serve target-revision work before the Host commit point.
- `REQ-CTXN-001` — Every participant phase is journaled and replayed with its original transaction, operation, generation, token, and digest.
- `REQ-CTXN-002` — Failure before commit uses proved compensation; failure after commit converges forward by default.
- `REQ-CTXN-003` — When either old or target convergence cannot be proven, affected work remains fenced in `Degraded`.
