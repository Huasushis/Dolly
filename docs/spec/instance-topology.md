# Dolly Instance Topology and Configuration Editing

Status: Draft

This document proposes the contract for declaring and changing a Dolly
instance's topology: which Pages exist, which Modules exist, and how each
Module is connected to Pages. It also covers how an Extension describes the
configuration that an operator may edit, and how the graphical editor and the
command-line interface (CLI) stay equivalent.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119. Because this
document is a Draft, these words describe the proposed contract. No
implementation may claim conformance to it.

Nothing in this document is implemented. There is no topology editing
application programming interface (API), no graphical editor, and no reload
path. The instance configuration validator in `src/core/runtime-config.ts`
checks a topology that is supplied once at startup; it does not accept a
change. The CLI has one read-only command, `dolly config show`, and reserves
`dolly config edit`, which currently fails with the message that
revision-checked, schema-aware editing is not implemented. Section 14 lists the
storage and locking primitives that already exist, what this contract still
depends on, and what remains unresolved.

## 1. Purpose and authority

The project owner's original idea requires four things that no accepted
contract covers today:

- the configuration file declares Pages, declares Modules instantiated from
  Extensions, and declares each Module's input and output Pages;
- a graphical editor can change the Page/Module connections and the instance
  can then reload them;
- Extensions can expose their settings so a Module can be configured while the
  system is running, from a management interface and from the CLI; and
- editing must also be possible directly, by editing the configuration or using
  the CLI, without being forced through the graphical editor.

`docs/takeover/confirmed-user-requirements.md` records the owner requirement
identifiers that constrain this work. `OWNER-CORE-001` through
`OWNER-CORE-005` fix the meaning of a connection: a Module observes the newly
available Blocks from all of its input Pages as one ordered batch, returns zero
or one Block, and that Block is broadcast to every configured output Page, with
per-delivery occurrence counting when one Block arrives more than once.
`OWNER-RESEARCH-001` keeps speculative scheduling and memory mechanisms out of
this contract.

This document does not restate `core-runtime.md`, `extension-process-protocol.md`,
`security-operations.md`, or `console-extension.md`. It refers to them. Where
this document appears to extend one of them, Section 14 records the extension
explicitly so that the other contract can be corrected rather than silently
contradicted. The authority order in `docs/spec/README.md` applies.

## 2. Scope and non-goals

This document covers:

- the authoritative representation of the topology inside the instance
  configuration document;
- the operations that change it and the single pipeline all of them use;
- validation rules for identifiers, references, cycles, and repeated
  connections;
- the effect of each class of topology change on running state, including which
  changes may be applied without restarting the instance process, which require
  a new Module generation, and which must be refused;
- how an Extension declares the configuration an operator may edit, and the
  limits on what it may contribute;
- concurrent editing and revision conflict handling;
- binding an edit to one exact instance when a control plane manages several;
  and
- the conformance tests required before any of this can be accepted.

This document does not define:

- the visual design, layout, component library, or interaction details of the
  graphical editor;
- the transport, authentication, or session mechanics of the management
  interface, which belong to `security-operations.md`;
- starting, stopping, or supervising instance processes, which belongs to
  `security-operations.md` Section 7;
- the external chat surface, which belongs to `console-extension.md`;
- Extension packaging and installation, which belongs to
  `extension-process-protocol.md`; or
- scheduling policy, period selection, or activation-rate adaptation.

## 3. Terminology

- **Topology**: the set of configured Pages, the set of configured Modules, and
  the input and output connections between them, as recorded in one instance
  configuration revision. The word is used in its ordinary graph sense.
- **Connection**: one directed binding between one Module and one Page. An
  input connection makes the Module a consumer of that Page. An output
  connection makes the Module a producer that appends to that Page. A
  connection has no identity of its own; it exists because a Page identifier
  appears in a Module's input or output list.
- **Editing interface**: one authenticated way for an operator to change the
  topology. This document defines exactly two: direct configuration editing,
  which covers editing the configuration document and using the CLI, and the
  graphical editor.
- **Change plan**: the validated result of comparing a proposed configuration
  revision with the current one. It lists, for every affected Page, Module, and
  connection, what the change does and what runtime effect applying it has. It
  is a review and authorization artifact, not stored runtime state. A plain
  textual difference is not sufficient, because the same text change can be
  harmless or destructive depending on pending delivery obligations.
- **Reload**: applying a newly committed configuration revision to a running
  instance without restarting the instance process. Restarting one Module
  generation is part of a reload; restarting the instance process is not.
- **Presentation annotation**: operator-supplied display data such as a node
  position or a human-readable label used only for drawing the editor. It is
  not part of the topology and never changes behavior.
- **Effective Module configuration document**: the single JavaScript Object
  Notation (JSON) document that an Extension's Module actually receives, after
  extension-level defaults and Module-level overrides have been merged and
  validated. It is the document stored behind the immutable configuration
  reference defined by `extension-process-protocol.md` Section 7.1.1.

## 4. Authoritative representation of the topology

### 4.1 The topology lives in the instance configuration

The topology is part of the closed instance configuration schema
`dolly.instance/9` defined by `core-runtime.md` Section 5.1. It consists of:

- `pages`: the declared Pages, each with a unique `pageId`;
- `modules`: the declared Modules, each with a unique `moduleId`, the
  `extensionId`, `packageVersion`, and `moduleKind` that identify the installed
  Extension code, an `isolation` mode, a `configurationReference` tuple,
  `permissionPolicyIds`, an activation declaration, limits, and timeouts; and
- each Module's input and output Page identifier lists, which are the
  connections.

A Page has no configuration beyond its identifier in the current schema. A Page
is not owned by a Module: it is a named broadcast log that any number of
Modules may consume from and any number of Modules may append to, as
`core-runtime.md` Section 7.1 defines.

A Module's connection lists are configuration, not runtime data. A Module
cannot discover, choose, or change them. `OWNER-PREMISE-002` and
`core-runtime.md` Section 9.2.1 keep the graph itself invisible to Module code:
a Module receives the descriptions published by adjacent Modules, never the
graph. A Module result MUST NOT be able to name an output Page, and an
Extension MUST NOT be able to request a connection change.

### 4.2 One source of truth

The current pointer and canonical resolved configuration in the shared Runtime
SQLite authority database are the only authoritative representation of the
topology. Its positive integer revision is allocated by the transaction in the
normative Storage and Recovery contract; a digest verifies exact content but is
not converted to the integer. The graphical editor is one client over that
record. It MUST NOT maintain a separate graph store, cached authoritative copy,
or state from which configuration is later regenerated.

Concretely:

- Every read the editor performs MUST resolve to one exact
  `(instanceId, revision, digest)` record, and the editor MUST display which
  revision it is showing.
- Every write MUST produce a complete candidate instance configuration document
  that is validated as a whole and submitted to the one authority transaction.
- There MUST NOT be an editor-only representation, legacy JSON file, or
  language-specific store that can drift from the committed database record,
  and there MUST NOT be a repair or resynchronize operation that chooses between
  two current configurations. If such an operation would be needed, the design
  has two sources of truth and violates this section.
- Deleting the editor's own state MUST NOT change the topology.

### 4.3 Presentation annotations

Operators need node positions and labels to make a graphical editor usable.
Presentation annotations MUST NOT be stored in the instance configuration
document, because they would change the configuration revision, invalidate
another editor's compare-and-swap, and produce audit events for moving a box on
a screen.

Presentation annotations:

- MUST be stored in separate control-plane state keyed by `instanceId` and by
  the `pageId` or `moduleId` they describe;
- MUST NOT be an input to validation, the change plan, reload, or any runtime
  decision;
- MUST be optional. A missing, stale, or corrupt annotation MUST NOT block
  reading or editing the topology, and the editor MUST be able to lay out a
  topology it has never seen before; and
- MAY be edited without an audit event, because they carry no authority. An
  annotation referring to a removed Page or Module MUST be ignored and MAY be
  collected.

### 4.4 Topology that another contract owns

Some Modules have their Page sets bound by a higher-level authorization object.
`console-extension.md` Section 4.2 defines a Console route revision that binds
exactly one ingress Module instance with one static output Page set and one
egress Module instance with one static input Page set, and it forbids reusing a
Module instance for another Page topology.

The topology editor MUST detect that a Module's connections are owned by such a
binding and MUST refuse to edit them directly, reporting which contract owns
them and which operation to use instead. It MUST NOT silently apply the edit,
and it MUST NOT silently rewrite the owning object. This applies to both
editing interfaces.

## 5. Two equivalent editing interfaces

### 5.1 One pipeline

Every topology change, from every editing interface, MUST pass through the same
pipeline in this order:

1. **Authenticate and authorize.** The actor is authenticated and authorized
   for the specific instance and operation, per `security-operations.md`
   Section 4.1. Authorization is checked server-side; interface visibility is
   never an authorization check.
2. **Build a complete candidate document.** The operation produces a full
   instance configuration document, not a patch that the runtime interprets
   later.
3. **Validate.** The candidate is validated against the closed schema and every
   rule in Section 6. Validation is total: the same candidate always produces
   the same verdict and the same error codes.
4. **Plan.** The change plan in Section 7 is computed by comparing the
   candidate with the currently effective revision and with current runtime
   obligations.
5. **Confirm what needs confirming.** Any plan entry classified as breaking
   requires an explicit confirmation naming the exact consequence.
6. **Commit by compare-and-swap.** The candidate is written atomically and
   assigned a new revision only if the currently stored revision still equals
   the expected revision supplied by the caller, per `security-operations.md`
   Section 9.
7. **Audit.** The audit event is emitted with the actor, instance, expected
   revision, new revision, and the plan summary.
8. **Apply.** The runtime reconciles the new revision, or, for a stopped
   instance, records it as desired for the next startup.

An interface MUST NOT skip, reorder, or privately extend these steps. In
particular, no interface may commit without a change plan, and no interface may
apply without committing.

### 5.2 Direct configuration editing

Direct editing has two forms, and both use the pipeline above.

**CLI.** The CLI calls the same control-plane operations as the graphical
editor. It MUST NOT write the configuration file, the state directory, the
Delivery store, or any runtime record directly while an instance owns them. It
supplies the expected revision explicitly, receives the same change plan, and
receives the same error codes. Non-interactive use MUST be able to print the
plan as structured JSON and MUST exit non-zero when the operation is refused.

**Editing a configuration file.** An operator may prepare a configuration
document in a text editor. This remains possible for every change that the
graphical editor can make, but the file is proposal/import input, not an
authoritative instance configuration.

A hand-edited file MUST NOT take effect implicitly:

- The daemon MUST NOT watch the configuration file and apply changes because
  its bytes changed. An unvalidated file write is not an authorized, planned,
  compare-and-swap-checked commit, and a partially saved file must never reach
  the Runtime.
- A hand-edited file becomes effective only through an explicit authenticated
  apply operation that reads the file, validates and normalizes it, computes
  exact canonical resolved bytes/digest, computes the plan, and performs the
  compare-and-swap against the revision the operator expected. When invoked
  without an expected revision, it MUST show the plan and require confirmation
  before committing, and it MUST refuse if the stored revision changed between
  showing the plan and confirming.
- For a stopped instance, import/apply acquires the same controller lock and
  uses the same SQLite transaction. Initial legacy migration follows the
  expected-source procedure; after its commit, startup ignores the file for
  current selection even if archival or removal was interrupted.

The graphical editor MUST NOT be required in order to reach any state that the
graphical editor can produce. If a topology can be drawn, it can be written.

### 5.3 Graphical editing

The graphical editor is a client of the same control-plane operations. It MUST
NOT hold a privileged channel, a private operation, or an unvalidated write
path. It MUST NOT construct a configuration document that the CLI could not
also submit.

The editor MAY compose several logical edits into one submitted revision, for
example adding a Page and three connections at once. That composition is an
ordinary candidate document; it does not create a new operation kind, and the
CLI MUST be able to submit the same composed candidate.

### 5.4 Capability parity

The set of topology and configuration operations exposed to the graphical
editor MUST be exactly the set exposed to the CLI. Neither may have an
operation, an option, a bypass, or a validation relaxation the other lacks.

This is a testable statement, not a design aspiration: the operation set is a
declared, versioned list, and a conformance test compares the two exposures for
equality, including operation names, required arguments, error codes, and
confirmation requirements. Adding an operation to the management interface
without adding it to the CLI MUST fail that test.

Presentation-only capabilities are exempt because they are not topology
operations: the CLI is not required to draw a graph, and the editor is not
required to expose a text buffer. Section 4.3 keeps presentation annotations
outside the configuration precisely so this exemption cannot widen.

### 5.5 Equivalence of results

Two edits that express the same logical change MUST produce the same
configuration content, regardless of which interface produced them.

Precisely: given the same starting revision and the same logical change,
the candidate documents produced by the CLI and by the graphical editor MUST
have identical canonical JSON bytes under the RFC 8785 JSON Canonicalization
Scheme rules in `core-runtime.md` Section 5, and therefore the same digest and
transaction result. Neither interface may introduce ordering differences,
defaulted fields the other omits, or annotations the other lacks. The integer
revision is the next committed allocator value, never a digest-derived value.

Ordering inside the document MUST therefore be deterministic and defined by the
schema, not by the order in which an operator clicked or typed. If the schema
treats a list as a set, both interfaces MUST serialize it in the same defined
order.

## 6. Validation rules

Validation is defined over a complete candidate document. It MUST NOT depend on
which interface produced the document, on the change plan, or on runtime state.
Rules that do depend on runtime obligations belong to Section 7 and are part of
the plan, not of validation.

### 6.1 Identifiers

`pageId` and `moduleId` are opaque identifiers under the rules in
`core-runtime.md` Section 5: non-empty strings with validated syntax, never
interpreted as filesystem paths. The instance configuration validator currently
accepts an identifier matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. That implementation detail is evidence
of the intended shape; the accepted contract MUST state the exact pattern for
`dolly.instance`, and both editing interfaces MUST apply that one pattern.

A `moduleId` is not a display name. `extension-process-protocol.md` Section 8
keys a Module's private storage namespace by `moduleId`, so the identifier is
also a durable data boundary. Section 7.11 treats changing it accordingly.

### 6.2 Uniqueness and referential integrity

- Every `pageId` in `pages` MUST be unique.
- Every `moduleId` in `modules` MUST be unique.
- Every Page identifier appearing in any Module's input or output list MUST
  name a Page declared in `pages`. A dangling connection MUST be rejected.
- A Page declared in `pages` with no connection at all is valid. An isolated
  Page is a useful intermediate state while editing, and refusing it would make
  a Page and its first connection impossible to add in two steps. The plan
  SHOULD report it as an informational finding.
- A Module with output connections and no input connections is valid only when
  its activation permits it; see Section 6.5.

### 6.3 Cycles and self-connections

The Page graph MAY contain cycles. This is explicit in the owner's original
model, which states that the graph may have cycles, and it is required by
ordinary Dolly topologies where two Modules answer each other. A validator MUST
NOT reject a candidate because the graph is cyclic, and neither editing
interface may refuse to draw or write one.

A Page MAY be both an input and an output of the same Module. This is also
explicit in the owner's model and is already assumed by `memory-extension.md`
Section 8, which requires an output Page that is also an input Page to remain
safe. The Module then receives the Blocks it produced.

Self-connection is a correctness obligation on the Module, not on the topology
editor. The runtime MUST NOT filter a Module's own Blocks out of its input,
because doing so would silently change delivery semantics; `console-extension.md`
Section 6.3 defines the deduplication that one such Module performs. The change
plan SHOULD report a newly created self-connection as an informational finding
so an operator is not surprised, but it MUST NOT refuse it.

### 6.4 Repeated and parallel connections

A Module's input list and output list are sets. The same `pageId` MUST NOT
appear twice in the same list. A repeated entry is a malformed document, not a
request for double delivery, and MUST be rejected rather than silently
deduplicated, so that an operator's mistake is visible.

Two Modules connected through two different Pages are not a duplicate. That
topology is meaningful and its semantics are already defined: one Block
travelling through both Pages produces two Deliveries, and
`core-runtime.md` Section 7.3 groups them into one Block delivery group with
`occurrenceCount` equal to 2, preserving both Delivery identities. This matches
`OWNER-CORE-005`. Validation MUST accept it, and the plan MUST NOT describe it
as an error.

### 6.5 Activation constraints

- A Module whose activation is `source` MUST have no input connections.
- A source Module's `subscriptionStart` MUST be `from-head`; the field applies
  to its Core-private queue, and accepting `from-now` would make retained
  activation requests depend on when composition happened to reconcile it.
- A Module whose activation is not `source` MUST have at least one input
  connection.
- Instance schema version 9 can represent reactive, periodic, and source
  declarations, but representation is not proof that a mode can start. Package
  manifest version 1 supports only reactive activation.
- `dolly.extension-package/2` is already reserved by `schema-registry.md` for
  the complete payload-schema registration contract. It MUST NOT be introduced
  as an activation-only partial schema. Until the full contract can also declare
  periodic compatibility, verified Extension composition rejects periodic
  before process start even though the Scheduler component can model its
  delivery-backed timing policy.
- `dolly.extension-package/3` retains the complete version-2 producer schema
  and may declare one Module kind as `source`. The candidate installed
  composition then derives the same private queue for Runtime and Scheduler;
  package versions 1 and 2 remain reactive-only. It can accept requests from a
  future trusted manual or external ingress owner. A periodic source remains
  rejected until an automatic producer durably records each clock activation.
- `dolly.extension-package/4` retains the complete version-3 shape and may
  declare `periodic`. Candidate installed composition accepts it only with at
  least one input Page and `allowEmptyInput: false`; it uses the existing
  Delivery Claim and `module.execute` boundary and grants no background timer
  or capability to Extension code.
- Empty-input periodic activation and periodic source production remain
  unsupported. Source and non-empty periodic have component and
  product-before-bootstrap composition evidence. Product bootstrap still
  rejects all configured Modules. Editing and startup surfaces MUST report the
  unsupported implementation boundary, not call these declarations malformed.

### 6.6 Finite size limits

Every list in the topology MUST have a finite configured maximum: the number of
Pages, the number of Modules, and the number of input and output connections
per Module. A candidate that exceeds a limit MUST be rejected deterministically
with the limit named in the error. The current validator caps Pages at 4096 and
Modules at 1024; the accepted contract MUST state the normative limits.

### 6.7 Change classification

Each entry in the change plan carries exactly one classification:

- `informational`: no runtime effect. Example: adding an unconnected Page.
- `hot`: applied by reload without restarting any Module generation.
- `generation-restart`: requires stopping the affected Module's current
  generation and starting a new one. The old generation MUST be proven
  terminated first, per Section 7.1.
- `breaking`: destroys or retires state that cannot be recovered, such as a
  consumer's checkpoint or pending Deliveries. Requires explicit confirmation
  naming the exact obligations affected.
- `rejected`: cannot be applied in the current state. The plan states why and,
  where one exists, which operation would make it possible.

A classification MUST be derived from the change and the current runtime
obligations, never from operator intent or from which interface asked. The same
change against the same state MUST always receive the same classification.

### 6.8 Validation is whole-document and shared

Both interfaces MUST call one validator implementation over the whole candidate
document. Validating only the changed fields is not conformant: a change to one
Module can invalidate another Module's connection, and a change to `pages` can
invalidate several Modules at once.

## 7. Change semantics and reload

### 7.1 Invariants a reload MUST NOT bypass

Reload is a convenience for operators. It has no authority to weaken any
runtime rule. In particular:

- **No overlapping generations.** A new Module generation MUST NOT start before
  the old generation is proven terminated, per `core-runtime.md` Sections 9.1,
  9.4, and 10, and, for a Linux Module, before its control group is proven
  empty as required by `security-operations.md` Section 10 and Architecture
  Decision Record (ADR) 0009. A reload that cannot obtain that proof MUST leave
  the affected Module in its current state and report the change as incomplete.
  It MUST NOT report success.
- **No silent discard.** A reload MUST NOT drop an unacknowledged Delivery, an
  active Claim, a Module job, or a dead-letter record without an explicit,
  audited, confirmed disposition. `core-runtime.md` Section 7.5 already forbids
  silently discarding input on failure; a configuration edit is not an
  exception to that rule.
- **No unknown-outcome laundering.** A Claim preserved as an unknown outcome
  under `core-runtime.md` Section 7.6 and `security-operations.md` Section 13.1
  MUST NOT be resolved, released, or removed as a side effect of a topology
  edit. Removing the Module that owns it MUST be refused until the audited
  operator disposition for that Claim has been applied.
- **No fencing weakening.** Identity fields keep their meaning across a reload:
  a result from an old generation is stale and MUST be fenced, per
  `core-runtime.md` Section 15.3.
- **No implicit subscription start.** Every new consumer subscription created
  by a topology change MUST carry an explicit start position, per
  `core-runtime.md` Section 7.2.

### 7.2 The change plan

For every affected element, the plan states the element, the operation, the
classification from Section 6.7, and the concrete obligations involved:
pending Delivery counts, active Claims, dead-letter records, and the Module
generations that will be restarted. The plan MUST be computed before
confirmation and MUST be recomputed and revalidated at commit time, because
obligations change while an operator reads a screen. If a recomputed plan
differs from the confirmed one, the commit MUST be refused and the new plan
returned.

### 7.3 Adding a Page

Classification: `hot`.

A new Page starts empty. It has no consumers until a connection is added, and
adding it does not affect any running Module. Adding a Page and connecting it
in the same revision is permitted; the plan then contains both entries and the
connection entry carries its own classification.

### 7.4 Removing a Page

Removing a Page is the hardest case, and `core-runtime.md` does not currently
define it at all. This section proposes the missing rule; Section 14 records
that the core contract needs the corresponding addition.

A Page MUST NOT be removed while any of the following is true:

- a consumer of that Page has pending or claimed Deliveries;
- an active Claim, including one with an unknown outcome, covers a Delivery
  from that Page;
- a retained dead-letter record references a Delivery from that Page; or
- any incomplete Module result commit or outbox record names that Page as an
  output.

In those cases the plan entry is `rejected`, and it MUST name the exact
obligations rather than reporting a generic conflict.

To remove a Page that still has obligations, the operator performs the removal
in explicit steps, each of which is separately planned, confirmed, and audited:

1. Remove the connections to the Page. Removing an input connection is an
   audited consumer removal under Section 7.8. Removing an output connection
   stops new Deliveries from being appended.
2. Choose a disposition for the remaining obligations. Exactly two dispositions
   are permitted: `drain`, which waits until every consumer reaches a terminal
   disposition normally, and `dead-letter`, which records every remaining
   pending Delivery as a dead-letter record with its Block identifier, Delivery
   identifier, consumer, and the reason `page-removed`. A disposition that
   discards obligations without a record MUST NOT exist.
3. Remove the now-empty Page. Classification: `hot`.

Removing a Page does not delete the Blocks that were delivered through it.
Block lifetime is governed by reachability in `core-runtime.md` Section 8; a
Block referenced by a dead-letter record or another Page's Delivery remains
reachable.

A Page identifier MUST NOT be reused by a later revision until its removal is
complete and its Delivery log has been retired, so that a stale checkpoint or
audit record cannot be read against a different Page with the same name.

### 7.5 Adding a Module

Classification: `generation-restart` for the new Module only; other Modules are
unaffected.

Adding a Module requires:

- an installed Extension package whose manifest matches the exact `extensionId`
  and `packageVersion`, and which declares the requested `moduleKind`, per
  `extension-process-protocol.md` Section 3;
- a `configurationReference` tuple naming an existing immutable configuration
  record with the matching `configVersion`, per
  `extension-process-protocol.md` Section 7.1.1, which the control plane
  resolves and revalidates before the Module can start;
- an explicit start position for every input connection, per Section 7.7; and
- limits, timeouts, isolation, and exact permission-policy definition and
  backend-binding identifiers/revisions/digests that the deployment permits.

A newly added installed Linux Module reaches READY only after the ordered
activation-premise, service/runtime, delegated-root, startup-recovery handoff,
and installed-composition contract in `core-runtime.md` Section 5.3. READY is a
downstream observation and cannot fill a missing configuration, policy, binding,
service, or recovery premise. Until Module execution is enabled at all, the
plan entry is `rejected` with the reason recorded in Section 7.14.

### 7.6 Removing a Module

Classification: `breaking`.

Removing a Module removes one or more Page consumers, and
`core-runtime.md` Section 7.2 makes consumer removal an audited operation that
retires pending obligations and associated strong references. That rule is not
sufficient on its own, because it does not say what happens to a Module that is
currently executing, what happens to its pending Deliveries, or what the
operator is told. This section proposes the missing detail.

A Module MUST NOT be removed while:

- it has an active Claim, including one preserved as an unknown outcome; or
- its current generation is not proven terminated.

The removal therefore proceeds in this order:

1. **Quiesce.** The Module stops accepting new triggers and Claims. Its active
   Run is allowed its bounded grace period per `core-runtime.md` Section 10.
2. **Resolve outstanding work.** A Claim that reaches a terminal disposition
   normally requires no operator action. A Claim with an unknown outcome MUST
   be resolved through the audited flow in `security-operations.md`
   Section 13.1 before removal may continue. Removal MUST NOT be offered as one
   of that flow's dispositions.
3. **Prove termination.** The generation is stopped and proven terminated,
   including the control-group proof where ADR 0009 applies.
4. **Retire consumer state with a stated disposition.** For every input Page,
   the operator chooses `drain` or `dead-letter` as in Section 7.4. The audit
   event records the exact counts retired under each disposition, per Page.
   Silently dropping them is forbidden even though the consumer is going away.
5. **Release references.** Strong references owned by the Module's records are
   released, which may make Blocks and Media collectible under
   `core-runtime.md` Section 8.3.
6. **Decide the fate of Module-private storage.** The Module-private storage
   namespace keyed by `moduleId` is not part of the topology, and removal MUST
   require an explicit choice between retaining it for a later Module with the
   same identifier and deleting it. The default MUST be to retain, because
   deletion is not reversible. The choice MUST be recorded in the audit event.

Deliveries that the removed Module previously appended to its output Pages are
not withdrawn. They belong to those Pages and to their other consumers.

### 7.7 Adding a connection

**Adding an input connection.** Classification: `breaking` when it creates a
subscription that can replay history, `hot` otherwise; in both cases the
operator MUST choose the start position explicitly.

Creating a consumer subscription requires one of `from-head`, `from-now`, or an
exact valid checkpoint, per `core-runtime.md` Section 7.2. There is no default,
and neither editing interface may supply one. A graphical editor that creates a
connection by dragging MUST prompt for the start position before the candidate
document can be built; it MUST NOT pick `from-now` because it is the quiet
choice.

`from-head` means the earliest Delivery the Page still retains, which may be a
large batch that the new consumer must process. The plan MUST state the number
of Deliveries and bytes that the choice makes immediately pending, so the
operator is not surprised by an instant backlog. A checkpoint older than the
Page's retention frontier MUST fail visibly rather than silently becoming
`from-head`.

The resolved `startAfter` boundary is fixed when the subscription is created,
which is at apply time for a running instance and at the next startup for a
stopped one. The plan MUST say which, because `from-now` means different things
at those two moments. Once created, a restart MUST NOT reinterpret the choice.

**Adding an output connection.** Classification: `hot`.

A new output Page takes effect for the next Module job. A Module job that has
already been created keeps the exact output Page list it was created with. The
output Page set of an in-flight Module job MUST NOT change, because
`core-runtime.md` Section 7.1 commits the output Block, its Deliveries, and the
input acknowledgement as one transaction or through an equivalent recoverable
outbox, and rewriting the target set mid-transaction would make recovery
ambiguous.

### 7.8 Removing a connection

**Removing an input connection.** Classification: `breaking`.

This is a consumer removal for that one Page and follows the same disposition
rules as Section 7.6 step 4: `drain` or `dead-letter`, with audited counts. It
MUST be refused while the Module holds an active Claim covering a Delivery from
that Page.

Removing and re-adding the same connection does not restore the previous
position. The re-added connection is a new subscription and MUST carry a fresh
explicit start position under Section 7.7. Retaining a removed consumer's
checkpoint for later reuse is forbidden, because it would make a removed
consumer's state observable after its audited retirement and would let an
operator reach a position that no explicit choice selected.

**Removing an output connection.** Classification: `hot`.

The Module stops appending to that Page from the next Module job onward.
Deliveries already appended remain, and their consumers still owe
acknowledgement. Removing an output connection MUST NOT retract them.

### 7.9 Changing a Module's configuration reference

Classification: `generation-restart`.

A `configurationReference` is an immutable tuple of `configId`, `revision`, and
`configVersion`. Editing the configuration content creates a new revision, per
`extension-process-protocol.md` Section 7.1.1; it never overwrites the old one.
Activating it requires a revision-checked instance configuration update that
changes the complete tuple.

There is no in-place configuration mutation of a running Module generation. The
Module generation is stopped, proven terminated, and a new generation starts
with the new reference resolved and revalidated through the
`inspect -> resolve -> validate -> launch` sequence. A management interface
MUST NOT present configuration editing as taking effect instantly if a restart
is required; the plan states the restart.

If the new configuration requires a migration from an older `configVersion`,
the migration rules in `extension-process-protocol.md` Section 7.2 apply
unchanged. A migration that drops data, changes external identity, or broadens
authority requires explicit owner confirmation there, and the topology editor
MUST surface that confirmation rather than answering it.

### 7.10 Changing other Module fields

- `extensionId`, `packageVersion`, `moduleKind`, `isolation`: classification
  `generation-restart`. These change which code runs and under what boundary. A
  change from a stricter isolation to a weaker one MUST be classified
  `breaking` and MUST state plainly what authority the Module gains, per
  `security-operations.md` Section 10.
- `permissionPolicyIds`: classification `generation-restart`. Capability grants
  are established when the Extension process session starts and are not
  editable within a session. Broadening them is `breaking`. In the reserved
  version-10 schema, `permissionPolicyReferences` replaces the identifier list
  with exact definition and backend-binding identifiers, revisions, and
  digests. Changing any member or its installed-product origin has the same
  classification; equal labels never preserve authority across such a change.
- `limits` and `timeouts`: classification `generation-restart` by default.
  Reducing a limit while work is in flight MUST NOT invalidate an existing
  Claim retroactively; the existing Module job keeps the bounds it was created
  with, per the frozen-input rule in `core-runtime.md` Section 7.4.
- `activation`: classification `generation-restart`, and currently `rejected`
  for any value other than reactive, per Section 6.5.

### 7.11 Identity changes are not edits

`moduleId` and `pageId` are identities, not labels. Changing one is not a
rename: it is the removal of one element and the addition of another.

- Changing a `moduleId` MUST be planned and audited as a removal under
  Section 7.6 followed by an addition under Section 7.5, including the explicit
  choice about the Module-private storage namespace keyed by the old
  identifier, and including a fresh explicit start position for every input
  connection of the new Module.
- Changing a `pageId` MUST be planned as a Page removal under Section 7.4
  followed by an addition, with the same obligations.

Neither editing interface may present these as a rename, because a rename
implies preserved state that is not preserved. If an operator wants a
human-readable name that can change freely, that is a presentation annotation
under Section 4.3, and the accepted contract should add an optional display
name field that carries no identity.

### 7.12 Applying a revision

Commit and apply are separate. The commit is atomic: a new revision exists or
it does not. Applying it to a running instance is a sequenced reconciliation
that can be interrupted.

- Runtime status MUST report both the desired revision and the effective
  revision, per `security-operations.md` Section 9, so an incomplete
  application is visible.
- Reconciliation MUST be ordered so that no intermediate state violates
  validation: create Pages before the connections that reference them, and
  remove connections before the Pages they reference.
- A reconciliation step that cannot complete, such as a generation restart
  whose termination proof is unavailable, MUST leave the affected element in
  its previous state, record the failure with its element and reason, and
  continue with independent elements. It MUST NOT roll the whole revision back
  silently, and it MUST NOT report the revision as effective.
- Reconciliation MUST be idempotent and restartable, so a control-plane crash
  during apply is recoverable by running it again.

### 7.13 Reverting

Returning to an earlier topology is a new forward revision containing the
earlier content. It is planned, classified, and audited like any other change.

Reverting does not undo the runtime effects of the change it reverses. A
consumer removed by revision N is not restored by reverting to revision N-1: it
is a new consumer that requires a new explicit start position, and its retired
obligations stay retired. The plan MUST state this, because "revert" invites
the assumption that state comes back.

### 7.14 What the first implementation must reject

While Module execution is disabled, the runtime rejects every configured
Module, as `core-runtime.md` Section 5.1 states. Therefore:

- a plan entry that would start or restart a Module generation is `rejected`,
  with a reason that names the disabled capability rather than pretending the
  configuration is invalid;
- editing Pages and connections in a configuration document, validating it,
  planning it, and committing it remain possible, because they are exactly the
  operations an operator needs before Modules are enabled; and
- documentation MUST NOT describe topology editing as working end to end until
  the tests in Section 13 pass.

## 8. Extension-contributed configuration surfaces

### 8.1 Declaration reuses the package configuration schema

An Extension declares the configuration an operator may edit using the JSON
Schema it already publishes in its package manifest:
`modules[].configurationSchema` with its `configVersion`, per
`extension-process-protocol.md` Sections 3 and 7.1. There MUST NOT be a second
schema language, a second registration call, or a runtime-supplied form
description that competes with it.

The management interface renders an editing form from that schema. The CLI
renders the same schema as help text, defaults, and validation for its
arguments, and MUST be able to accept the whole document as JSON. Both are
views of one declaration.

Because the schema is static package metadata, it is discoverable without
executing Extension code, which `extension-process-protocol.md` Section 3
requires. This is deliberate: the control plane can render a configuration form
for an Extension whose process has never started.

### 8.2 Extensions contribute data, never code or markup

An Extension MUST NOT be able to contribute anything executable or renderable
to the management interface. Specifically it MUST NOT supply:

- JavaScript, WebAssembly, or any other code to run in the management origin;
- Hypertext Markup Language (HTML), Scalable Vector Graphics, stylesheets, or
  templates;
- event handlers, uniform resource locators (URLs) to load, iframe sources, or
  font, image, or script references;
- a custom control implementation of any kind; or
- text that is rendered as anything other than escaped plain text.

`security-operations.md` Section 4.3 already treats Extension strings as
untrusted display data that the console escapes by default and ships a
restrictive Content Security Policy for, and
`extension-process-protocol.md` Section 8 forbids promoting Extension text to
trusted user interface markup. `extension-process-protocol.md` Section 3
reserves renderer registration for a later package schema with its own security
review. This section states the consequence for topology and configuration
editing: the management interface renders host-owned controls chosen by the
host from the declared schema, and an Extension influences only which schema is
declared.

If presentation hints beyond standard JSON Schema keywords are ever needed,
they MUST be a closed, versioned, declarative vocabulary defined by the host,
interpreted only by the host, with unknown values ignored, and with no hint
able to change validation, authorization, or which fields exist. That
vocabulary is not defined here and is not required for a first version.

### 8.3 The rendered form is not an authorization boundary

Host-side validation against the declared schema is authoritative. Client-side
validation is a convenience. A field the form hides, disables, or omits is not
thereby protected: the control plane MUST reject an unauthorized or invalid
value regardless of what any client displayed, per
`security-operations.md` Section 4.1.

Secrets MUST be masked in the interface and MUST NOT be retrievable after
submission except through a dedicated re-authenticated export operation.

### 8.4 Extension-level defaults and Module-level overrides

The owner requires that an Extension's configuration act as the common
configuration for all of its Modules, and that a Module's configuration
subdivide and override it.

Two stored documents express that:

- **Extension-level defaults**: one document per
  `(extensionId, moduleKind, configVersion)`, holding values shared by that
  Extension's Modules in this instance.
- **Module-level overrides**: one document per Module, holding only the values
  that differ.

Neither is delivered to a Module. The host merges them into the effective
Module configuration document, validates that merged document in full against
the declared schema, and stores it as the immutable record identified by the
Module's `configurationReference`. The Module therefore always receives one
complete, validated, immutable document, and
`extension-process-protocol.md` Section 7.1.1 is preserved unchanged.

The merge MUST be deterministic and MUST use exactly this rule:

1. Start from the defaults document.
2. Apply the overrides document recursively. When both sides have an object at
   the same key, merge their keys recursively. Otherwise the override value
   replaces the default value entirely.
3. Arrays, strings, numbers, booleans, and null replace wholesale. Arrays are
   never merged element-wise, appended to, or deduplicated, because element-wise
   array merging has no unambiguous meaning and produces results no operator
   predicts.
4. An override MUST NOT delete a key. To return a value to the schema default,
   the operator sets it explicitly. This keeps the merge free of a deletion
   marker that would have to be excluded from every schema.
5. The host then materializes schema defaults deterministically, per
   `extension-process-protocol.md` Section 7.1, and validates the result.

Each layer on its own MUST be an object whose property names exist in the
declared schema; a property name unknown to the schema is rejected in the layer
that introduced it, so the operator is told which document is wrong. Only the
merged document is validated in full, because a defaults document is normally
incomplete.

Conflicts are resolved by the merge rule, not by a warning: the Module-level
value wins. The interface MUST show, for every field, the effective value, the
layer it came from, and the value it overrode when it overrode one. A conflict
that the merge cannot resolve, such as an override object where the schema
requires a string, is a validation error naming both layers.

### 8.5 Propagating a change to extension-level defaults

Changing extension-level defaults changes the merged result for every Module
that does not override the affected value. Because the effective document is
stored behind an immutable reference, that change does not take effect by
itself, and it MUST NOT.

Editing the defaults therefore:

- MUST compute, for every affected Module, the new effective document, its new
  configuration record revision, and the resulting instance configuration
  change;
- MUST present the complete list of affected Modules with the classification
  from Section 6.7, which is `generation-restart` for each of them; and
- MUST apply as one planned, confirmed, compare-and-swap instance configuration
  commit, or not at all. Applying to some Modules and not others because the
  operator did not notice them is forbidden.

An operator MAY choose to apply the defaults change to a subset of Modules; the
unselected Modules then keep their current effective documents, and the plan
records that they are now behind the defaults. That state MUST be visible in
status, because a silently diverging Module is the failure mode this rule
exists to prevent.

### 8.6 Secrets

Raw secrets MUST NOT appear in extension-level defaults, Module-level
overrides, the merged document, the change plan, the audit event, or any
editing interface, per `extension-process-protocol.md` Section 6.1 and
`security-operations.md` Section 6. Configuration refers to a deployment-owned
secret binding by stable non-secret name. The editing interface presents the
name and never the value.

## 9. Concurrent editing

### 9.1 Compare-and-swap on an exact revision

Every mutating operation MUST carry the revision the caller believes is current
and MUST be committed only if the stored revision still equals it, per
`security-operations.md` Section 9. The check and the write MUST be atomic,
under the configuration lock.

A mismatch MUST fail with a stable, distinguishable error that reports the
expected revision, the actual current revision, and enough information for the
caller to re-read and re-plan. It MUST NOT be reported as a generic write
failure, and it MUST NOT be retried automatically with the new revision
substituted, because that would silently apply an edit computed against
different content.

### 9.2 No automatic merging

Two concurrent topology edits MUST NOT be merged automatically, even when they
appear to touch different elements. Topology validity is a whole-document
property: two independently valid edits can compose into an invalid or
semantically surprising document, for example one adding a connection to a Page
that the other removed.

The second writer re-reads, re-plans against the new revision, and resubmits.
The interface MAY show a difference to help, but the operator confirms the
re-planned change.

### 9.3 What an editing interface must display

Both interfaces MUST make these three values distinguishable, and the graphical
editor MUST display them continuously rather than only in an error dialog:

- the **expected revision**, the revision the current edit is based on;
- the **desired revision**, the latest committed revision; and
- the **effective revision**, the revision the runtime has actually applied,
  which may lag during reconciliation or after a partial apply.

When the expected revision is not the desired revision, the editor MUST show
that its view is stale and MUST refuse to submit until the operator re-reads.
When the desired revision is not the effective revision, the editor MUST show
that the instance has not finished applying the configuration, together with
the per-element failures from Section 7.12. Presenting a configured topology as
if it were running when it is not is forbidden.

### 9.4 Lock scope

The configuration lock protects configuration reads and writes. Holding it does
not authorize starting, stopping, or restarting anything, and a long-running
apply MUST NOT hold it for the duration of the reconciliation. Operations that
change process state are authorized and serialized separately, per
`security-operations.md` Section 7.

## 10. Multiple instances

### 10.1 Every operation names one instance and one revision

A control plane may manage several instances. Every topology read and every
topology write MUST bind to one exact `instanceId` plus, for writes, one exact
expected revision. A display name, working directory, port, process identifier,
or configuration file path is not an identity, per
`security-operations.md` Section 9.

The graphical editor MUST show the `instanceId` and its display name together
wherever a topology is shown or edited, because two instances of the same
deployment normally have similar topologies and identical Page names.

### 10.2 No broadcast edits

An edit MUST NOT be applied to several instances by one operation. Applying the
same logical change to N instances is N separate operations, each with its own
expected revision, its own plan, its own confirmation, and its own audit event.
A single confirmation cannot cover several plans, because the same change has
different consequences against different pending obligations.

A control plane MAY offer to prepare the same change for several instances and
walk the operator through them one at a time.

### 10.3 Clone and rebind

`security-operations.md` Section 9 defines `rebind`, which moves configuration
while preserving identity, and `clone`, which creates an independent copy with
a new instance identifier.

A clone copies the topology. It MUST NOT copy consumer checkpoints, Claims,
Module jobs, dead-letter records, or Module-private storage from the source
instance, because those describe work the source instance owns. Every input
connection in the clone therefore starts a new subscription and requires an
explicit start position, resolved when the clone first creates its
subscriptions. The clone operation MUST make that choice explicit rather than
defaulting it.

### 10.4 Editing a stopped instance

Editing a stopped instance is supported through both interfaces. The plan is
computed against persisted state rather than live runtime state, and it MUST
say so, because a Page that looks drainable offline may have pending
obligations that only startup recovery reveals.

Startup revalidates the configuration and reconciles the configured Page
topology before making Modules ready, per `core-runtime.md` Section 15.2. A
change that was accepted offline may still be refused at startup; that refusal
MUST name the element and reason and MUST NOT be resolved by discarding
obligations.

### 10.5 Data directories and running several instances

`displayName` and `stateDirectory` are instance fields, not topology.
`stateDirectory` selects where an instance keeps its state, which is what makes
running several instances side by side possible.

Changing `stateDirectory` MUST NOT be hot-applied and MUST be refused while the
instance is running. Moving state is the `rebind` operation in
`security-operations.md` Section 9, not a configuration edit. Editing the field
to a different directory while the instance is stopped creates an instance
pointing at empty or foreign state; the control plane MUST warn that no state
is migrated by the edit.

## 11. Audit and observable status

Every committed topology change MUST emit a structured audit event under
`security-operations.md` Section 11 containing at least: timestamp, event type,
result, operation identifier, actor identity, `instanceId`, expected revision,
new revision, and the plan summary, including each `breaking` entry with its
retired obligation counts and chosen disposition.

Both editing interfaces MUST emit the same event types with the same fields for
the same change. The interface used MAY be recorded as an attribute of the
actor; it MUST NOT change which events exist. A conformance test compares the
events produced by both interfaces for one identical change.

Runtime status MUST expose, without reading private internal state:

- desired and effective configuration revisions;
- per-element application state and failure reasons for an incomplete apply;
- for each Page, the consumers subscribed to it and their pending obligations,
  which is what makes a removal plan reviewable; and
- for each Module, its generation, lifecycle state, and resolved configuration
  record revision, so that a Module still running an older configuration is
  visible.

## 12. Error codes

Both editing interfaces MUST return the same stable error codes for the same
condition. The list below is the proposed minimum; the accepted contract fixes
the exact names and their payloads.

Existing codes MUST be reused rather than duplicated under a topology-specific
name. `RUNTIME_CONFIG_INVALID` and `RUNTIME_CONFIG_TOPOLOGY_INVALID` remain the
codes for schema and topology validation failures. `CONFIG_REVISION_CONFLICT`,
already returned by the instance configuration store, remains the code for a
failed compare-and-swap in Section 9.1; a second name for the same condition
would make one failure look like two.

- `TOPOLOGY_PLAN_STALE`: obligations changed between planning and confirmation.
- `TOPOLOGY_CONFIRMATION_REQUIRED`: a `breaking` entry was not confirmed.
- `TOPOLOGY_PAGE_HAS_OBLIGATIONS`: a Page removal is refused; the payload names
  the pending Deliveries, Claims, and dead-letter records.
- `TOPOLOGY_MODULE_BUSY`: a Module change is refused because a Claim is active
  or a generation is not proven terminated.
- `TOPOLOGY_UNKNOWN_OUTCOME_PRESENT`: the change would remove or restart a
  Module holding a Claim with an unknown outcome.
- `TOPOLOGY_START_POSITION_REQUIRED`: a new subscription has no explicit start
  position.
- `TOPOLOGY_CHECKPOINT_UNAVAILABLE`: the requested checkpoint is older than the
  Page's retention frontier.
- `TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT`: the Module's Page set is bound by a
  route or equivalent object; the payload names the owning contract and
  operation.
- `TOPOLOGY_CAPABILITY_DISABLED`: the change is valid but depends on a
  capability that is not enabled, such as Module execution.
- `CONFIG_LAYER_UNKNOWN_PROPERTY`: a defaults or overrides document contains a
  property name the declared schema does not define; the payload names the
  layer.

The following codes were added by the first control-plane implementation
because no code above covers their condition. Each names a refusal an operator
can act on, and each is returned identically by both editing interfaces.

- `TOPOLOGY_START_POSITION_UNSUPPORTED`: the operator chose a valid start
  position that the current instance schema cannot record. `dolly.instance/9`
  carries one `subscriptionStart` per Module restricted to `from-head` or
  `from-now`, so an exact checkpoint is expressible in the operation but not in
  the document. This is distinct from `TOPOLOGY_CHECKPOINT_UNAVAILABLE`, which
  means the checkpoint itself is gone; a caller that conflates them would
  retry a request that can never succeed. Section 14.3 item 3 records the
  schema change that removes this code.
- `TOPOLOGY_START_POSITION_CONFLICT`: one Module's new connections requested
  different start positions, or requested a position that disagrees with the
  one its retained connections already use, and the single per-Module field
  cannot record both. It disappears with the same schema change.
- `TOPOLOGY_DISPOSITION_REQUIRED`: removing one input connection would retire
  pending Deliveries or dead-letter records and no `drain` or `dead-letter`
  disposition was chosen. `TOPOLOGY_PAGE_HAS_OBLIGATIONS` covers the Page-level
  case; this covers the per-connection case in Section 7.8, which has its own
  payload naming the consumer.
- `TOPOLOGY_STORAGE_DECISION_REQUIRED`: a Module removal did not state whether
  the Module-private storage namespace keyed by its `moduleId` is retained or
  deleted. Section 7.6 step 6 requires that choice to be explicit and
  recorded in the audit event, so it cannot be defaulted silently.
- `TOPOLOGY_PLAN_REJECTED`: a plan entry is `rejected` and carries no more
  specific code. It exists so that a refusal is never reported as a success;
  an implementation SHOULD return the specific code instead wherever one
  applies.

## 13. Required conformance tests

Acceptance requires automated tests for at least the following. Each is
falsifiable and none asserts only that a status string was returned.

1. **Interface equivalence.** For a fixed starting revision and a fixed logical
   change, the candidate document produced through the CLI and through the
   graphical editor's operations has identical canonical JSON bytes/digest and
   receives the same transaction-allocated integer revision.
2. **Capability parity.** The declared topology and configuration operation
   sets exposed to the two interfaces are equal, including operation names,
   required arguments, confirmation requirements, and error codes. Adding an
   operation to one exposure only fails the test.
3. **Same validator.** A candidate that one interface rejects is rejected by
   the other with the same error code and the same offending element.
4. **Page removal with obligations is refused.** Removing a Page while a
   consumer has pending Deliveries returns `TOPOLOGY_PAGE_HAS_OBLIGATIONS` and
   names the exact counts. After an explicit `dead-letter` disposition, the same
   removal succeeds and a dead-letter record exists for every previously
   pending Delivery, with reason `page-removed`. No test path exists in which
   the count of retired obligations exceeds the count of recorded dispositions.
5. **Module removal with an unknown outcome is refused.** A Module holding a
   Claim preserved as an unknown outcome cannot be removed; the operation
   returns `TOPOLOGY_UNKNOWN_OUTCOME_PRESENT`, and no audit event records a
   released Claim.
6. **Concurrent edit.** Two editors read revision R; the first commits; the
   second's commit fails with `CONFIG_REVISION_CONFLICT` reporting both
   revisions, and the stored document equals the first editor's result exactly.
7. **No automatic re-base.** After that conflict, no code path retries the
   second edit against the new revision without a new plan and confirmation.
8. **Invalid connection rejected.** A connection naming an undeclared Page is
   rejected by both interfaces before any commit, and no revision is created.
9. **Cycles and self-connections accepted.** A two-Module cycle and a Module
   whose output Page is also its input Page both validate, commit, and apply.
   The self-connected Module receives its own Block with the delivery grouping
   and occurrence count defined by `core-runtime.md` Section 7.3.
10. **Parallel Pages produce occurrence count 2.** Two Modules connected
    through two distinct Pages deliver one Block as one Block delivery group
    with `occurrenceCount` 2 and two distinct Delivery identifiers.
11. **Duplicate Page in one list rejected.** The same `pageId` twice in one
    Module's input list is rejected, not deduplicated.
12. **No overlapping generations on reload.** A change classified
    `generation-restart` never starts the new generation before the old one is
    proven terminated. The test injects a delayed termination proof and asserts
    that no second generation exists during the delay, and that the apply
    reports incomplete rather than success when the proof never arrives.
13. **Start position is mandatory.** Creating an input connection without an
    explicit start position fails with `TOPOLOGY_START_POSITION_REQUIRED`
    through both interfaces. A stale checkpoint fails with
    `TOPOLOGY_CHECKPOINT_UNAVAILABLE` and does not silently become `from-head`.
14. **Re-added connection does not resume.** Removing and re-adding an input
    connection produces a new subscription whose resolved `startAfter` follows
    only from the newly chosen start position, not from the retired consumer's
    checkpoint.
15. **In-flight output set is frozen.** Adding an output Page while a Module
    job exists does not change that job's output Page set; its committed
    Deliveries appear only on the original Pages.
16. **File edits do not auto-apply.** Writing the configuration file directly
    while the daemon runs changes nothing until the explicit apply operation is
    invoked, and a truncated or partially written file never reaches the
    runtime.
17. **Configuration layers merge deterministically.** For a fixed defaults
    document and overrides document, the effective document is byte-identical
    across repeated merges and across both interfaces; arrays replace rather
    than merge; an unknown property name in either layer is reported with the
    layer that introduced it.
18. **Defaults change is not silent.** Editing extension-level defaults does
    not change any running Module until a planned, confirmed instance
    configuration commit; Modules left behind are reported as diverged in
    status.
19. **Extensions contribute no code.** A package manifest containing HTML, a
    script, a URL, or a renderer registration is rejected at installation, and
    no Extension-supplied string reaches the management interface unescaped.
20. **Audit parity.** The same logical change through each interface emits the
    same audit event types with the same fields, differing only in actor
    attributes.
21. **Desired and effective revisions diverge visibly.** When reconciliation
    fails for one element, status reports the desired revision, the effective
    revision, and the failing element, and the editor displays the mismatch.
22. **Instance binding.** A topology operation carrying a valid revision but
    the wrong `instanceId` is refused, and no operation exists that applies one
    change to more than one instance.
23. **Clone does not inherit consumer state.** A cloned instance has no
    checkpoints, Claims, Module jobs, or dead-letter records from its source,
    and every input connection requires an explicit start position.
24. **Identity change is not a rename.** Changing a `moduleId` is planned as a
    removal plus an addition, requires the Module-private storage decision, and
    is never presented as a rename.

## 14. Dependencies, gaps, and required decisions

### 14.1 What already exists

The current code contains three primitives relevant to Section 5's pipeline,
but none is the accepted Runtime authority database:

- **Historical revision-checked JSON storage.**
  `src/core/instance-config-store.ts` loads and writes instance configuration
  under a cross-process lock, uses a canonical content digest as its revision,
  and reports `CONFIG_REVISION_CONFLICT`. That digest identity remains migration
  input only. It does not implement the append-only positive integer mapping,
  shared SQLite current pointer, prerequisite foreign keys, or premise-last
  transaction, and it cannot remain a second authority after migration.
- **Immutable Module configuration records.**
  `src/core/module-configuration-store.ts` creates and resolves the
  `dolly.module-configuration/1` record behind `configurationReference`,
  derives its immutable content identity from the content, validates the
  configuration against the declared schema, and refuses to overwrite one
  content identity with different bytes. That Module content identity is not
  the instance `config_revision` allocator.
- **Whole-document topology validation.** `src/core/runtime-config.ts` already
  enforces most of Section 6: identifier syntax, unique Page and Module
  identifiers, referential integrity of every input and output Page,
  no repeated Page in one list, the source-versus-non-source input rules, and
  finite list limits.

### 14.2 What this contract depends on that does not exist

- **Shared Runtime authority database.** No TypeScript/Rust composition yet
  implements schema version 1, the append-only integer config mapping, exact
  current pointer, prerequisite foreign keys, premise-last transaction, reopen
  checks, or offline legacy-JSON cutover. Configuration work cannot claim
  revision authority until those contracts and `TST-AUTH-004..006` pass.
- **Module execution.** Configured Modules are rejected by the runtime, per
  `core-runtime.md` Section 5.1 and decision register rows DEC-008 and DEC-009.
  Every plan entry that would start or restart a Module generation is therefore
  unreachable today.
- **A control plane.** There is no daemon-hosted management API, no graphical
  editor, and no editing command in the CLI. `dolly config edit` exists only as
  a reserved name that reports the feature as unimplemented.
- **The change plan.** Nothing computes the classification in Section 6.7 or
  the obligation counts in Section 7.2. Validation exists; planning does not.
- **Extension-level defaults and the merge.** Only one configuration document
  per Module exists. There is no defaults layer, no merge, and no propagation
  as described in Sections 8.4 and 8.5.
- **Package manifest capabilities.** Package schema version 1 requires
  `requestedCapabilities` to be empty and explicitly defers renderer
  registration and configuration migrations to a later schema. Section 8's form
  rendering works within version 1 because it uses only
  `configurationSchema`; anything richer waits for that later schema.
- **Reload of any kind.** `core-runtime.md` Section 9.4 states that the first
  Linux Module runner does not support dynamic Module reload. Section 7 of this
  document is therefore a contract for a later profile, and its first
  implementation may only be the parts that do not touch a Module generation.

### 14.3 Gaps found in existing contracts

These are places where an accepted contract does not currently say enough for
topology editing to be specified without extending it. Each needs a change in
the owning document, not only here.

1. **Page removal is undefined.** `core-runtime.md` describes Page creation,
   delivery, retention, and consumer state, but never removal. It has no rule
   for a Page that still has pending Deliveries, dead-letter records, or an
   incomplete commit naming it as an output. Section 7.4 proposes the rule;
   `core-runtime.md` Section 7 needs the corresponding addition.
2. **Consumer removal is under-specified.** `core-runtime.md` Section 7.2 says
   removing a consumer is an audited operation that retires its pending
   obligations and associated strong references, and Section 8.1 makes audited
   consumer removal a terminal disposition that releases the Delivery strong
   reference. Together they permit unacknowledged Deliveries to disappear as
   long as the operation was audited. Nothing requires the operator to choose a
   disposition, nothing requires the retired obligations to be enumerated, and
   nothing forbids removal while the consumer holds an active Claim. That is in
   tension with the rule that a Module exception must not silently discard
   input. Section 7.6 proposes the missing detail. **This is the most important
   gap in this document's area, and I do not consider the existing rule
   sufficient.**
3. **The released instance schema cannot express a per-connection start
   position.**
   `core-runtime.md` Section 7.2 requires each consumer subscription to choose
   `from-head`, `from-now`, or an exact checkpoint. The instance configuration
   in the repository carries one `subscriptionStart` per Module, restricted to
   `from-head` or `from-now`, covering all of that Module's input Pages at
   once, and `core-runtime.md` Section 5.1 does not show the route fields at
   all. Adding one connection to an existing Module therefore cannot express
   its own start position, and no checkpoint can be configured. Making
   Section 7.7 implementable requires a new instance schema version.
   `core-runtime.md` Section 5.3 reserves `dolly.instance/10`, in which each
   input connection is an object carrying its own start position. Its explicit
   migration maps the current per-Module value onto every existing connection
   without changing Page order. Version 10 remains unreleased until its
   Scheduler, mailbox, permission, Linux execution, and recovery gates are also
   complete; the connection change must not ship as a partial version 10.
4. **`core-runtime.md` Section 5.1 does not document the connection fields.**
   It refers to "Page routes" in prose while the code uses `inputPageIds`,
   `outputPageIds`, and `subscriptionStart`. The authoritative field names and
   their constraints should be in the contract, since this document's
   validation rules refer to them.
5. **Console route ownership versus general Module editing.**
   `console-extension.md` Section 4.2 requires new ingress and egress Module
   instance identifiers whenever a route's Page set changes, and forbids
   reusing a Module instance for another Page topology. `core-runtime.md`
   imposes no such rule on Modules generally. Section 4.4 resolves this by
   refusing direct edits to route-owned Modules, but the general rule remains
   an open question; see Section 14.4.
6. **No audit event type covers topology changes.**
   `security-operations.md` Section 11 lists configuration changes generically.
   Topology changes need their own event type with the plan summary and retired
   obligation counts, or reviewers cannot tell a connection change from a limit
   change in the audit log.

### 14.4 Decisions the owner should make

These are product choices, not engineering details. Each has a recommendation.

1. **Does changing a Module's connections keep its identity?** The Console
   contract says no for route-bound Modules: a Page-set change produces new
   Module instance identifiers. Generalizing that rule to every Module would
   make rewiring safe and uniform, but it would also change `moduleId` on every
   rewire, and `moduleId` keys the Module's private storage namespace, so every
   rewire would abandon the Module's accumulated data. That directly conflicts
   with the requirement that each Module has its own isolated data directory
   that persists. *Recommendation: keep Module identity across a connection
   change, require a generation restart and an explicit subscription
   disposition, and keep the Console carve-out as the exception.*
2. **What disposition may an operator choose for pending Deliveries when
   removing a Page, a Module, or a connection?** This document permits `drain`
   and `dead-letter` only, and no discard. A discard option would be simpler
   for a development instance and dangerous everywhere else. *Recommendation:
   no discard option at all; a developer who wants a clean slate deletes the
   state directory, which is honest about what it does.*
3. **May a topology be edited while the instance is running, at all?** This
   document assumes yes, because the owner asked for a graphical editor with
   reload. A conservative first release could restrict editing to a stopped
   instance and make "reload" mean "restart the instance", which is far less
   work and cannot violate the generation rules. *Recommendation: specify the
   full contract as written, but ship stopped-instance editing first and enable
   live reload per change class as the termination proofs land.*
4. **How much history may `from-head` replay?** A new consumer choosing
   `from-head` on a large Page can create an enormous immediate backlog.
   Options are to allow it with the plan stating the size, to require an extra
   confirmation above a configured threshold, or to forbid it above a
   threshold. *Recommendation: allow it, state the size in the plan, and
   require the extra confirmation above a configured threshold.*
5. **Should a Page and a Module carry an editable display name?** Identifiers
   cannot be renamed without destroying state, which will surprise operators
   who expect to rename a node in a graphical editor. Adding an optional
   display name that carries no identity solves that cleanly, at the cost of
   one more field and the need to show both in every interface.
   *Recommendation: add it, and make the editor show the identifier alongside
   it wherever an operation is authorized.*
6. **Where do presentation annotations live when several operators share a
   control plane?** Per-operator layouts avoid conflicts but mean two people
   see different graphs; a shared layout is consistent but needs its own
   concurrency handling. *Recommendation: one shared layout per instance,
   last-write-wins, no audit, because it carries no authority.*
