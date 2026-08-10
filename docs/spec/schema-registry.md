# Content Schema Registry Specification

Status: Draft

This document proposes the contract for owning a content-item schema name:
which publisher may produce items under a name, how the validator for that name
is pinned so it cannot drift, and when a naming conflict is detected. It exists
because `console-extension.md` Section 5.5 and Section 15.1 item 8 require a
registry that does not exist, so their requirement currently has nothing to
attach to.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119. Because this
document is a Draft, these words describe the proposed contract and no
implementation may claim conformance to it.

Nothing in this document is implemented. There is no schema registry: `src/core/`
contains `json-schema.ts`, which compiles and runs a JSON Schema document, and
`extension-installation-registry.ts`, which installs and resolves Extension
packages. Neither has a publisher, a name claim, or a pinned validator. The one
piece that does exist is the deliberately narrow interim check described in
Section 8.3. Section 11 records what this contract depends on, what it
contradicts, and what the owner must decide.

## 1. Purpose and authority

`block-payload.md` Section 2 defines a `data` content item as
`{"type": "data", "schema": ..., "value": ...}` and says the schema names
extension-owned structured information. It does not say who owns a name, so
today any producer may emit any name.

That is a security problem, not only an organizational one.
`console-extension.md` Section 5.5 depends on
`dolly.console.message-boundary/1` being producible by exactly one publisher,
because the message stream those boundaries structure is assembled into a
language model prompt. A producer that can forge a boundary can inject
conversation structure that the model reads as the host's own framing. The same
argument applies to any future name whose meaning a consumer acts on.

### 1.1 Why this cannot be built incrementally

The difference between the narrow reserved-name check that exists today
(Section 8.3) and a registry is not a data structure. It is **where identity
comes from**.

The existing check can be a compiled-in constant precisely because it does not
answer that question: it takes the producer's identity from deployment
configuration, where an operator stated it directly. A registry has no such
escape. It must decide, for a name it has never seen, which publisher owns it —
and if that decision rests on anything the package says about itself, the whole
authorization is built on an assertion by the party it is supposed to constrain.

This is why a registry MUST NOT be built as a framework first with identity
added later. A registry without trustworthy publisher identity is not a partial
implementation; it is a working mechanism for the wrong thing, and its presence
tells every later reader that names are governed when they are not. Section 5
therefore derives identity entirely from records that already exist and are
already verified for integrity before any Extension code runs, and Section 5.2
lists what MUST NOT be mistaken for identity.

### 1.2 Relationship to other contracts

This document defines the general mechanism. It does not restate
`block-payload.md`, `extension-process-protocol.md`, or `core-runtime.md`; it
refers to them. Where it appears to extend one of them, Section 11.3 records the
extension explicitly so that the other contract can be corrected rather than
silently contradicted. The authority order in `docs/spec/README.md` applies.

## 2. Scope and non-goals

This document covers:

- the syntax of a content-item schema name and how ownership is derived from it;
- the reserved namespace and how a reserved name receives a producer;
- where publisher identity comes from and what does not establish it;
- how a validator is pinned to a name and what happens when it drifts;
- when registration conflicts are detected, and why that must be before a
  Module starts; and
- the relationship between registry enforcement and the existing
  `dolly.content/1` validation.

This document does not define:

- the wire protocol for delivering a registration, which belongs to
  `extension-process-protocol.md`;
- renderer behavior or presentation, which belongs to the consuming contract;
- package signing or provenance, which `extension-process-protocol.md`
  Section 3 defers to a later package schema; or
- schema evolution for the closed host documents such as `dolly.instance/9`,
  which are versioned by their owning contracts and are not extension-owned.

## 3. Terminology

- **Content schema name**: the `schema` string of a `data` content item, for
  example `dolly.console.message-boundary/1`. It is an identity, not a
  description.
- **Publisher**: the installed Extension package that owns a name, identified
  as described in Section 5.
- **Producer grant**: authority to emit items under one name. Held by exactly
  one publisher and Module role.
- **Consumer entry**: a registration that declares a publisher can *render* or
  *interpret* a name. It carries no producer authority.
- **Pinned validator**: the JSON Schema document registered for a name,
  together with the digest that detects any change to it.
- **Registration set**: the complete set of registrations Core resolves for one
  instance configuration revision before any Module starts.

## 4. Names and ownership

### 4.1 Name syntax

A content schema name MUST match one exact pattern, and that pattern MUST be
enforced by the same whole-document content validator that already validates a
`data` item. The proposed form is a dotted name, a solidus, and a decimal
version: `^[a-z][a-z0-9]*(\.[a-z0-9-]+)+/[1-9][0-9]{0,3}$`.

This is a change, not a restatement. `block-store.ts` constrains a Block
`payload.schema` with a name pattern, but `block-content.ts` requires a `data`
item's `schema` only to be a non-empty string. Ownership cannot be derived from
a name whose syntax is unconstrained, so the accepted contract MUST fix the
exact pattern and `block-payload.md` MUST state it.

The version suffix is part of the name. `example.thing/1` and
`example.thing/2` are two distinct names with independent registrations,
independent validators, and independent producer grants. A consumer that
understands one MUST NOT assume anything about the other.

### 4.2 Ownership is derived, never asserted

The leading segments of a name determine its owner:

- A name beginning with `dolly.` is **reserved** and belongs to the host. See
  Section 4.3.
- Every other name MUST begin with the `extensionId` of the publisher that
  registers it, followed by a further segment. An Extension whose
  `extensionId` is `acme.summary` may register `acme.summary.report/1` and MUST
  NOT register `acme.other/1` or `dolly.anything/1`.

Ownership is therefore a property Core computes from the manifest it already
read, not a claim the package makes about itself. A registration whose name
does not derive from its publisher's `extensionId` MUST be rejected. This is
what makes "who owns this name" answerable without trusting the answer's source.

The prefix comparison MUST be over whole segments, not over characters. An
`extensionId` of `acme.sum` does not own `acme.summary.report/1`, even though it
is a character prefix of it. An implementation that compares with a plain string
prefix and no separator lets any publisher claim every namespace that starts
with its own identifier's letters, which is the whole rule inverted.

**Not every `extensionId` can prefix a name.** `extension-installation-registry.ts`
accepts an `extensionId` matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, which
permits uppercase letters, `_`, and `:`; the name syntax above permits none of
them. The prefix rule would otherwise be unsatisfiable for such a publisher.

The accepted contract MUST therefore define a **registrable `extensionId`**: one
that is itself a valid sequence of name segments under Section 4.1. An Extension
whose identifier is not registrable simply cannot register a content schema name,
and MUST be told so at installation rather than discovering it at Module start.

Deriving a prefix by transforming the identifier — lowercasing it, or stripping
the disallowed characters — MUST NOT be done. Two distinct identifiers such as
`Acme.Thing` and `acme.thing` would derive the same prefix, which converts a
naming rule into a way for one publisher to claim another's namespace.

### 4.3 The reserved namespace

`dolly.` names are reserved for the host and for first-party Extensions acting
on the host's behalf. A reserved name MUST NOT receive a producer grant from a
package manifest, because that would let installing a package claim host
authority.

A reserved name receives its producer only from **deployment configuration**
that names the exact publisher and Module role, and that configuration is an
audited administrative change under `security-operations.md` Section 11. The
default for a reserved name with no configured producer is that **nobody may
produce it**; see Section 6.4.

`dolly.` is the only reserved prefix, and the reserved-prefix list is fixed by
this contract. It MUST NOT be a configuration option. A deployment able to add a
reserved prefix could reserve one that an Extension is already using
legitimately, which would retroactively strip that Extension of names it owns
under Section 4.2 — turning a configuration setting into a way to expropriate
another publisher's namespace. Adding a prefix is therefore a contract change,
reviewed as one.

## 5. Publisher identity

### 5.1 Where identity comes from

Publisher identity MUST be the resolved installation record that Core already
produces before any Extension code runs. `ExtensionInstallationRegistry`
resolves an installation to its `extensionId`, `packageVersion`, `trust`, and
`packageDigest`, rechecks the manifest, file list, content digests, paths, and
permissions, and reports a tampered installation as a distinct failure. That is
the only existing object with a stable identity, an integrity digest, and
verification that happens before execution.

A producer grant is therefore keyed by the triple
`(extensionId, packageVersion, moduleKind)`. The Module role is part of the key
because `console-extension.md` Section 5.5 requires producer authority to
belong to the exact Console ingress publisher **and** Module role: an Extension
that legitimately owns a name for one of its Module kinds does not thereby let
its other Module kinds emit it.

At commit time the producing source is `{kind: "module", id: moduleId}`. Core
resolves that to a grant along one chain, and every link already exists:

1. `moduleId` names one entry in the committed instance configuration revision;
2. that entry declares `extensionId`, `packageVersion`, and `moduleKind`; and
3. those three select at most one producer grant in the registration set.

If any link is missing or ambiguous, the commit MUST be refused. Resolution
MUST NOT fall back to matching on `extensionId` alone.

### 5.2 What does not establish identity

None of the following grants a producer a name, alone or in combination:

- the package name, display name, or description;
- the installation path or directory layout;
- a package signature, which `extension-process-protocol.md` Section 3 states
  may establish provenance but will not grant capabilities or trust by itself;
- an `ExtensionTrust` of `trusted`, which describes the deployment's judgement
  about the code, not ownership of a name;
- holding a consumer entry for the same name; or
- having produced items under the name in an earlier revision.

The last two matter most in practice. Registering a renderer for a name is the
common legitimate reason to mention it, and it MUST NOT be promotable into
producer authority. Prior production is the shape a name-squatting attack
takes after one successful commit, so it MUST NOT be self-justifying either.

### 5.3 Producer grants and consumer entries are different objects

Exactly one publisher and Module role MAY hold the producer grant for a name.
Any number of publishers MAY hold consumer entries for it. The two MUST be
separate record types with separate authorization, so that no code path can
read one where it meant the other.

The first version of this contract registers **producers only**. A consumer
entry grants nothing, and the host chooses its own renderers, so registering
consumers would add a record type and an authorization surface for something
that confers no authority.

If consumers later need to be discoverable, adding them is **a new decision, not
an extension of this one**, and it MUST be taken as such. The hazard is specific:
a discovery list that grants nothing today is easily read as an authority list
tomorrow — "it is in the registry, so it is legitimate". Nobody announces that
reinterpretation; it happens because the list is already there and looks
official. A future consumer registry MUST therefore state in its own text what
it does not grant.

## 6. Pinning the validator

### 6.1 What a registration records

One producer registration records at least:

- the name;
- the publisher triple from Section 5.1;
- the validator: one JSON Schema Draft 2020-12 document;
- `validatorDigest`, the canonical digest of that document;
- `maxValueBytes`, a finite bound on the canonical size of a conforming
  `value`; and
- whether the value may contain Core references. `console-extension.md`
  Section 5.5 requires the Console boundary to declare their absence, and the
  default MUST be that a registered value carries none.

The digest MUST be computed over the canonical JSON form of the validator
document, using the RFC 8785 canonicalization and SHA-256 digest that
`canonical-json.ts` already implements for configuration revisions. Reusing
that mechanism means a validator identity and a configuration revision are the
same kind of value and can be compared with the same code.

### 6.2 Drift

**Drift** is any difference between the validator document Core resolves from
the installed package now and the `validatorDigest` recorded in the
registration set. Drift MUST fail closed: the affected Module MUST NOT start,
and Core MUST report the name, the expected digest, and the observed digest.

Drift is not a corner case. It is what a tampered installation, an incomplete
upgrade, or a package that rewrites its own manifest looks like from Core's
side, and the difference between those causes is not observable at the moment
of detection. Refusing to start is the only response that is correct for all of
them.

### 6.3 Changing a validator is a new registration, never an edit

A validator MUST NOT change because a package upgrade happened to carry
different bytes. Silently accepting a new validator for an existing name would
make every previously committed item's meaning retroactively uncertain:
consumers would have validated against one document and later readers against
another, with nothing recording which applied.

Which route a change takes is decided by one question: **does it change the set
of values the name accepts?**

**A change to the accepted set MUST use a new name version** (`example.thing/1`
to `example.thing/2`, per Section 4.1). The audited registration change below is
not available for it, and neither is any operator confirmation.

The reason is that a name is meant to identify a shape. If the accepted set
could change under a fixed name, two items carrying that name could have
different shapes, and a reader holding one of them would have to determine which
era it came from — by correlating it against an audit log that would then have to
be complete and retained forever. Since Section 11.4 decides not to record the
validator digest on each committed item, the only way to keep "the name
identifies the shape" true is to make the name change whenever the shape does.
The version suffix already exists for exactly this, so the cost is one
identifier, not a mechanism.

**A change that provably does not alter the accepted set** — correcting a
description, a title, or an error message; tightening a redundant constraint that
no conforming value could violate — MAY use an audited registration change. That
change MUST require operator confirmation naming the old and new digests, and
Core MUST first confirm that the accepted set is genuinely unchanged.

If Core cannot confirm that, the change MUST be treated as a change to the
accepted set and MUST use a new name version. An unverifiable check is worse
than a missing one: it reports a guarantee it did not establish. One extra name
version costs an identifier; a wrong "unchanged" verdict silently reintroduces
the ambiguity this section exists to prevent.

### 6.4 Absent registration fails closed

A `data` item whose name is reserved, or whose name has a registration set
entry, MUST be refused unless the producing source resolves to that name's
producer grant. A name with **no** registration at all is ordinary
extension-owned data and is not restricted by this document — but a **reserved**
name with no configured producer MUST be refused for every source.

Forgetting to configure a producer therefore denies the name rather than
opening it. A check that permits what it was not told about is not a check.

## 7. Building the registration set

### 7.1 Resolution happens before any Module starts

Core MUST build the complete registration set for one instance configuration
revision **before** it starts any Module generation, in the phase that already
resolves and validates installations. Every conflict in Section 7.2 MUST be
detected there.

Detecting a conflict at first validation instead — that is, the first time a
Block happens to carry the contested name — is forbidden. That timing makes the
failure nondeterministic, moves it into production traffic, and allows the
wrong producer to have committed items under the name before anyone notices.
`console-extension.md` Section 5.5 states this directly: a name collision fails
before Module start.

### 7.2 Conflicts

Each of the following MUST fail closed while building the registration set, and
MUST name the offending registration:

1. two different publisher triples claiming the producer grant for one name;
2. one publisher registering the same name twice with different validators;
3. a name that does not derive from its publisher's `extensionId`
   (Section 4.2);
4. a manifest claiming a name in the reserved namespace (Section 4.3);
5. a name that does not match the required syntax (Section 4.1);
6. a validator that is not a valid JSON Schema Draft 2020-12 document, or whose
   compilation fails; and
7. a registration whose `maxValueBytes` is absent, non-finite, or above the
   deployment's configured ceiling.

A conflict MUST NOT be resolved by preferring the first, the newest, the
`trusted`, or the alphabetically smaller registration. Every such rule silently
picks a winner in exactly the case an attacker constructs.

### 7.3 The set is bound to one configuration revision

The registration set is derived from one committed instance configuration
revision and the installations it names. A topology or configuration change
that adds, removes, or re-versions a Module produces a new registration set,
computed and conflict-checked by the same rules, per
`instance-topology.md` Section 5.1.

## 8. Enforcement at Block commit

### 8.1 The existing content validation is not relaxed

Registry enforcement is **additional**. The closed `dolly.content/1` validation
in `block-payload.md` Section 2 runs unchanged and first: a `data` item remains
exactly `{type, schema, value}` with no unknown fields, `items` remains
non-empty, and every existing limit still applies. No registration may widen,
disable, or substitute for any of it.

Only after that does the registry check apply, in this order:

1. the name's syntax and, if it is registered or reserved, the producer grant;
2. the pinned validator, against the item's `value`; and
3. `maxValueBytes`, against the canonical size of `value`.

### 8.2 The enforcement point

The check MUST run inside Core on the path that turns a Module result into a
Block, before the Block is created — not after, with a rollback. A refusal that
withdraws an already-created Block means a forged item existed, however briefly,
and anything observing Core state in that window saw it.

The check MUST NOT be delegated to the producing Extension, and
`block-payload.md` Section 2 agrees: the Core decides who may use a name, and
runs the pinned validator itself where one exists. A producing Extension
asserting its own eligibility is not a check.

### 8.3 Relationship to the interim reserved-name check

`src/core/reserved-content-schema.ts` implements a deliberately narrow subset
of this contract: a closed, compiled-in list of reserved names, a
host-configured producer identity per name, a fail-closed default, and refusal
inside `BlockStore.normalizeInput` before an identifier is allocated. It exists
because `console-extension.md` Section 5.5 needed enforcement before this
registry could be specified, and it was built to be replaceable rather than
extended: it cannot register a name at runtime and cannot carry a validator.

When this contract is accepted and implemented, that module is **subsumed**:
reserved names come from the registry, and the producer grant resolves through
Section 5.1 instead of a hand-written policy object. Until then it MUST remain,
and it MUST NOT be removed before the registry enforces at least the same rule
for the same names, so that no revision exists in which neither check runs.

**That replacement is not automatically an improvement, and it MUST be checked
rather than assumed.** The interim check is safe for a specific reason: its
producer identity comes from an operator naming a publisher directly, which no
package can influence. Substituting the registry replaces that with a derived
identity chain. The substitution is an upgrade only if that chain is at least as
trustworthy as an operator's direct statement; if it is weaker at any link, the
substitution is a downgrade wearing the appearance of one.

This is written down because the appearance is strong and one-directional.
Replacing a hand-configured constant with a general registry reads as progress
by construction, and nobody performing that replacement will spontaneously stop
to compare the two identity sources. Whoever performs it MUST make that
comparison explicitly and record the result.

## 9. Error codes

Existing codes are reused rather than duplicated.
`BLOCK_RESERVED_SCHEMA_FORBIDDEN`, already returned by the interim check,
remains the code for a commit refused because the source does not hold the
producer grant. `EXTENSION_INSTALLATION_TAMPERED` remains the code for an
installation whose files no longer match their digests.

The following are proposed additions; the accepted contract fixes their exact
names and payloads:

- `SCHEMA_NAME_INVALID`: the name does not match the required syntax.
- `SCHEMA_NAME_NOT_OWNED`: the name does not derive from the publisher's
  `extensionId`.
- `SCHEMA_NAME_RESERVED`: a manifest claimed a name in the reserved namespace.
- `SCHEMA_REGISTRATION_CONFLICT`: two registrations contest one name; the
  payload names both publishers.
- `SCHEMA_VALIDATOR_INVALID`: the registered document is not a compilable JSON
  Schema Draft 2020-12 document.
- `SCHEMA_VALIDATOR_DRIFT`: the resolved validator digest differs from the
  registered one; the payload carries both digests.
- `SCHEMA_VALUE_INVALID`: the item's `value` does not satisfy the pinned
  validator.
- `SCHEMA_VALUE_LIMIT_EXCEEDED`: the canonical `value` exceeds
  `maxValueBytes`.

## 10. Required conformance tests

Acceptance requires automated tests for at least the following. Each is
falsifiable and none asserts only that a status string was returned.

1. **Ownership is derived.** An Extension registering a name outside its
   `extensionId` prefix fails with `SCHEMA_NAME_NOT_OWNED`, and no Module of
   that package starts.
2. **The reserved namespace cannot be claimed by a manifest.** A package
   declaring a `dolly.` name fails with `SCHEMA_NAME_RESERVED` regardless of its
   `ExtensionTrust`.
3. **A reserved name with no configured producer is refused for everyone**,
   including the publisher that would normally own it.
4. **A consumer entry never grants production.** A publisher holding only a
   consumer entry for a name is refused at commit with
   `BLOCK_RESERVED_SCHEMA_FORBIDDEN`, and the refusal happens before any Block
   identifier is allocated.
5. **Conflicts fail before Module start.** Two publishers claiming one name
   fail while the registration set is built; the test asserts that no Module
   generation was started, not merely that an error was returned.
6. **Conflicts are not silently arbitrated.** No ordering of the two
   registrations, and no difference in trust or version, causes one to win.
7. **Drift fails closed.** Changing one byte of a registered validator changes
   its digest and prevents the Module from starting, with both digests
   reported.
8. **A validator change is not an edit.** A package upgrade carrying a
   different validator for an existing name does not take effect without the
   audited registration change, and the old digest remains in force until it
   does.
9. **A change to the accepted set cannot use the audited path.** A registration
   change whose new validator accepts a value the old one rejected, or rejects
   one the old one accepted, is refused however it is confirmed, and is
   accepted only under a new name version. A test that supplies such a pair and
   an operator confirmation must still observe the refusal.
10. **Refusal precedes creation.** For every refusal path at commit, the Block
   identifier generator is never called and the store gains no record. A test
   that moves the check after creation must fail this assertion while still
   observing the thrown error, so that "rejects" and "rejects before creating"
   cannot be confused.
11. **The existing validation is not relaxed.** Every `dolly.content/1` case
    that is rejected without a registry — unknown item type, unknown field on a
    `data` item, empty `items`, missing `value` — is still rejected with a
    registry present.
12. **Unregistered names are unaffected.** A name that is neither reserved nor
    registered is committed normally, and a name differing only in version
    suffix from a reserved one is treated as unrelated.
13. **The grant binds the Module role.** A package that owns a name for one
    `moduleKind` is refused when a different `moduleKind` of the same package
    emits it.
14. **A correctly granted producer is permitted.** With the grant in place, the
    authorized publisher and Module role commits an item under the name, and the
    Block exists afterwards.

    This item is not a formality. Every other test above asserts a refusal, a
    failure to start, or an unregistered name passing through untouched, so an
    implementation that refuses every reserved name unconditionally satisfies
    all of them. That implementation is also the one a deployment reaches by
    accident, because the default is fail-closed: a registry whose grant path is
    broken looks exactly like a registry whose grants have simply not been
    configured yet. Without this test, "nothing may produce this name" and "this
    name is correctly governed" are indistinguishable from the outside.

## 11. Dependencies, gaps, and required decisions

### 11.1 What already exists

- **Installation identity and integrity.**
  `extension-installation-registry.ts` resolves `extensionId`,
  `packageVersion`, `trust`, and `packageDigest`, and rechecks manifest, files,
  digests, paths, and permissions before returning an entrypoint. Section 5.1
  builds on it rather than introducing a second identity.
- **Schema compilation.** `json-schema.ts` compiles and runs a JSON Schema
  Draft 2020-12 document.
- **Canonical digests.** `canonical-json.ts` provides the RFC 8785
  canonicalization and SHA-256 digest that Section 6.1 uses for
  `validatorDigest`.
- **A narrow reserved-name check.** `reserved-content-schema.ts` plus its
  enforcement point in `BlockStore.normalizeInput`, described in Section 8.3.
- **A product-before-startup registration-set component.**
  `content-schema-registry.ts` validates derived Extension namespaces, exact
  publisher and Module-role identity, validator digests, conflicts, value byte
  limits, and pinned validators. `BlockStore.normalizeInput` can enforce that
  complete immutable set before allocating a Block identifier. It deliberately
  can now be built from integrity-checked `dolly.extension-package/2`
  installations by `resolveInstalledContentSchemaRegistrationSet`, and a
  `FileCoreStateStore` can bind that exact frozen set to Block restore and
  commit. The public runtime bootstrap still refuses every Module, and the
  installed Scheduler composition does not yet require this binding, so this is
  product-before-bootstrap evidence rather than a supported registry.

### 11.2 What this contract depends on that does not exist

- **A package manifest that can declare a registration now exists.**
  `extension-process-protocol.md` Section 3 defines
  `dolly.extension-package/2` as the complete first producer-registration
  manifest. Version 1 remains unchanged and cannot declare a registration.
  Version 2 does not silently acquire activation or capability fields.
- **A name syntax for `data` items.** `block-content.ts` requires only a
  non-empty string, so Section 4.1 is a new constraint that
  `block-payload.md` must state.
- **A startup phase that owns the registration set.** The pure installed-package
  resolver and FileCore binding exist, but the installed Scheduler composition
  has not yet made the exact same set a mandatory input and startup invariant.
  Public Module execution remains disabled.
- **Module execution.** Every enforcement path that depends on a Module
  starting is unreachable until Modules run at all.

### 11.3 Gaps found in existing contracts

This document makes claims about four documents it does not own:
`block-payload.md`, `extension-process-protocol.md`, `console-extension.md`, and
`security-operations.md`. Every such claim was checked against those documents
when it was written.

**Whoever changes one of those four is obliged to come back and recheck the
claims here.** This is not a disclaimer about accuracy at some past moment; it
is an instruction about who does what and when. These statements do not expire
visibly, announce themselves as outdated, or fail any test when they stop being
true — they simply become false and keep reading as authoritative. Two of them
already went stale once, when `block-payload.md` Section 2 was rewritten, and
they were corrected by hand because someone remembered to look.

Nothing in the toolchain detects this. Until something does, the recheck is a
person's obligation, and naming it here is the only mechanism there is.

1. **Resolved: `block-payload.md` Section 2 conflated three questions.** It
   previously said a `data` item's schema "must be validated by the producing
   extension before the Block is committed", and said nothing about who may use
   a name. That sentence did not contradict the reserved-name authorization
   check outright — the check governs *who may use a name*, while the sentence
   governed *whether the value is validated*, which are different questions. Its
   defect was subtler and worse: by assigning validation to the producer and
   leaving authorization unmentioned, it invited a reader to conclude that the
   producer was responsible for both, and a producer asserting its own
   eligibility is no check at all.

   `block-payload.md` now answers the three questions separately: who may use a
   name (the Core, never the producer), whether the value is checked (only where
   the Core holds a pinned validator, and then the Core runs it), and what an
   opaque value means (the producer's concern, and explicitly not a claim that
   anyone validated it). This document's Section 8.1 is the registry half of
   that answer. **No action remains.**
2. **`block-payload.md` does not constrain a `data` schema name.** Section 4.1
   requires an exact pattern; the owning document must state it.
3. **`extensionId` is more permissive than a schema name can be.** The
   installation registry accepts uppercase letters, `_`, and `:` in an
   `extensionId`. Section 4.2 needs a registrable-identifier rule, and
   `extension-process-protocol.md` Section 3 should state at installation time
   whether an identifier is registrable, so a publisher learns it then rather
   than when its Module fails to start.
4. **Resolved: `console-extension.md` Section 5.5 used registry vocabulary that
   nothing defined** — "producer manifest", "closed validator digest",
   "registry entries", "publisher". That section now refers to this document for
   the mechanism and keeps only the Console-specific facts: the empty-object
   value schema, the absence of extra Core references, and producer authority
   belonging to the exact Console ingress publisher and Module role. Section
   15.1 item 8 additionally records which of Section 10's acceptance tests are
   reachable before `dolly.extension-package/2` exists. **No action remains.**
5. **No audit event type covers a registration change.**
   `security-operations.md` Section 11 lists configuration and extension
   capability changes generically. A registration change under Section 6.3 and
   a reserved-name producer grant under Section 4.3 need their own event types
   with the old and new digests, or a reviewer cannot tell a validator change
   from an unrelated configuration edit.

### 11.4 Decisions taken

These were open product choices. All five are now decided; the normative text
lives in the sections named, and this section records the reasoning so a later
reader can see what was weighed rather than only what was chosen.

1. **An extension-owned name MUST be prefixed with its `extensionId`.**
   Section 4.2. The alternative — a claimed name checked only for collisions —
   makes ownership first-come-first-served and turns installation order into an
   authorization input. The prefix rule makes ownership derivable rather than
   asserted, so squatting is impossible instead of merely detectable. A scheme
   that is only detectable is permanently lost after one missed detection; a
   derivable one has no such state.
2. **The first version registers producers only.** Section 5.3. A consumer entry
   grants nothing, so registering one would add an authorization surface for
   something that confers no authority. Making consumers discoverable later is
   **a new decision, not an extension of this one**, because a list that grants
   nothing today is easily reread as an authority list tomorrow — "it is in the
   registry, so it is legitimate" — and that reinterpretation is never
   announced.
3. **The validator digest is NOT recorded per committed item, and a change to
   the accepted set MUST use a new name version.** Section 6.3. Per-item digests
   would make each item self-describing at a storage cost that does not pay for
   itself. But not recording them only stays safe while a name identifies one
   shape, so the accepted set may not move under a fixed name: an audited
   registration change is available only for a change that provably does not
   alter which values are accepted, and where that cannot be confirmed, the new
   name version is mandatory. This is narrower than first proposed, and
   deliberately so — the earlier form would have left two shapes sharing one
   name, recoverable only by correlating against an audit log that would then
   have to be complete forever.
4. **`dolly.` is the only reserved prefix, and the list is fixed by contract.**
   Section 4.3. A configurable reserved-prefix list would let a deployment
   reserve a prefix an Extension already uses legitimately, expropriating a
   namespace by configuration. Adding a prefix is a contract change.
5. **A reserved name's producer MAY be an `untrusted` Extension.** Section 4.3
   and Section 5.2. Trust describes the isolation enforced on the code, not
   ownership of a name; coupling them would quietly make `trusted` a way to
   acquire names, which is the same error shape as letting an Extension vouch
   for itself — a property established for one purpose silently becoming a route
   to a different authority.
