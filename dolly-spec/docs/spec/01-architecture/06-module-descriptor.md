# Module Descriptor and premise projection

The Module Descriptor replaces mutable free-form “premise” strings as the
authoritative capability contract. An LLM-facing premise is a deterministic
projection of a frozen Descriptor snapshot; it is not a second source of truth.

## Record and ownership

`REQ-DESC-001` — Every configured Module MUST have an immutable, versioned
Descriptor matching `schemas/module-descriptor.schema.json`. Identity,
`descriptor_revision`, trust class, and graph relationship are Runtime-trusted.
An Extension proposes descriptive content and action contracts; the Runtime
validates and commits a new revision.

The Descriptor separates:

- `accepts`: input Part/Action kinds and a bounded semantic summary;
- `emits`: output Part/Action kinds and a bounded semantic summary;
- `actions`: exact unique names, content-addressed argument and
  successful-result schema bindings, descriptions, and side-effect classes;
- `activation_replay_contract`: the Runtime-approved rule for automatic replay
  after a dispatch has been fenced;
- `trust`: `system`, `trusted`, or `untrusted` as assigned by policy;
- namespaced metadata that is preserved but not interpreted as authority.

A Descriptor MUST NOT grant a capability. It only advertises a contract. An
Action is consumable only when its containing Block reaches the target Module
through a Page/Activation and the target, negotiated action schema, and
capability policy all authorize it. There is no action side-channel RPC.

## Action schema bindings

Every `arguments_schema` and `result_schema` is the closed `SchemaBinding`
`{uri, schema_digest, semantic_validator}` defined by
`schemas/module-descriptor.schema.json`; a bare URI string is invalid. `uri`
names an installed JSON Schema resource and MAY include a fragment. A relative
URI resolves only beneath the immutable verified package root that supplied the
Descriptor. The Runtime MUST NOT fetch a schema from the network while
validating a Block or Activation result.

`schema_digest` content-addresses the complete transitive schema resource
closure, not only the fragment or root file. The canonical bundle is:

```json
{
  "schema": "dolly.schema-bundle/v1",
  "root": "<root resource $id>",
  "resources": {
    "<resource $id>": {"<complete JSON Schema resource>": "..."}
  }
}
```

`resources` contains the root and every transitive non-meta-schema `$ref`
resource exactly once, keyed by its absolute `$id`; unresolved references,
duplicate `$id` values, or a reference escaping the verified package are
invalid. The digest is `sha256:` followed by lowercase SHA-256 of the bundle's
UTF-8 JCS bytes. Fragment resolution happens only after this digest verifies.
Consequently, changing `common.schema.json` or any other dependency changes the
binding even when the root document does not.

`semantic_validator` is either JSON `null` or the closed object
`{id, revision}`. `null` asserts that JSON Schema validation is complete for the
Action field; it does not permit an unavailable validator to be skipped. A
non-null binding names an exact deterministic Runtime validator revision. The
referenced root result resource MUST carry the identical
`x-dolly-action-result-validator` annotation. A semantic validator MUST be pure,
bounded, deterministic, free of I/O and side effects, and capable only of
accepting or rejecting the already schema-valid value. It receives the frozen
Action, selected ActionContract, result value, and effective limits needed by
its declared contract; it MUST NOT repair data, grant authority, or consult
mutable current configuration.

The Module Descriptor itself binds
`org.dolly.validator.module-descriptor-actions` revision `1` through its
`x-dolly-action-set-validator` annotation. That validator MUST reject two
`actions` entries with the same `name`, even when every other field differs.
The Runtime MUST have exactly one ActionContract after lookup by name.

## Activation replay contract

An Extension Descriptor template MAY request an `activation_replay_contract`.
Omission is normalized to the closed value
`{"mode":"never_auto_retry","evidence":"none","ledger":null}`. A committed Descriptor MUST
contain the normalized object. Its only legal forms are:

| Mode | Evidence | `ledger` | Meaning |
| --- | --- | --- | --- |
| `never_auto_retry` | `none` | `null` | after dispatch, transport loss or an unstaged result never authorizes automatic redispatch |
| `fenced_replay` | `pure_compute` | `null` | the approved handler has no externally visible effect except its returned Activation result |
| `fenced_replay` | `activation_ledger` | closed ledger descriptor | the Extension durably deduplicates and reconciles the same Activation ID and manifest digest |

The activation-ledger descriptor contains an Extension-owned QualifiedName
`namespace`, a package-defined `schema_version`, and the fixed location
`module_state_directory`. The Runtime binds approval to all three values. The
ledger lives under the Module's Host-managed durable state directory, is keyed
by `(activation_id, manifest_digest)`, and MUST durably record intent before an
effect and the canonical result or unresolved outcome afterward. A replacement
generation is replay-compatible only after the Host verifies that this exact
namespace/version was retained or completed an approved atomic migration; a
fresh, missing, corrupt, or downgraded ledger is not evidence.

The Extension's requested value is not authority. The Runtime MUST validate the
evidence against package policy and Module configuration before committing the
Descriptor revision. It MUST reject every other mode/evidence pair. Approval of
`fenced_replay` is necessary but not sufficient for redispatch: the Host-owned
execution slot MUST first be proven empty, and the frozen deadline, attempt,
lease, external-outcome, and quarantine rules still apply.

The approved object is frozen by both the Descriptor revision and the resolved
configuration revision named by an Activation Manifest. A later Descriptor,
configuration, package, or policy change MUST NOT upgrade the replay authority
of an existing Manifest. Downgrading or revoking policy MAY fence new calls, but
resolution of already dispatched work still records the frozen contract and the
revocation decision.

## Revision and update

`descriptor.changed` is an untrusted notification that carries one complete
candidate Descriptor plus its claimed revision and digest. Its params MUST
conform to `DescriptorChangedParams` in
[`extension-notification-rpc.schema.json`](../../../schemas/extension-notification-rpc.schema.json).
The Host MUST verify that the outer Module/revision fields equal the embedded
Descriptor and that the claimed digest equals `sha256(JCS(descriptor))`; no
follow-up Extension fetch or mutable URI is authoritative. The candidate becomes
an immutable verified Descriptor revision only after:

1. strict schema and size validation;
2. execution of the bound Descriptor semantic validator, including unique
   Action names, and verification that every Action name is owned by the
   Extension ID;
3. reconstruction and digest verification of every referenced argument and
   successful-result schema bundle;
4. verification that every non-null semantic validator ID/revision is installed
   and exactly matches the referenced result-schema annotation;
5. policy validation of the claimed side-effect class;
6. deterministic canonicalization and digest; and
7. one durable revision transaction.

`REQ-DESC-003` — Verifying a Descriptor candidate does not make it active for
Manifest construction. Because a `GraphSnapshot` pins Descriptor and policy
revisions, activating the candidate MUST occur only in the atomic configuration/
graph installation that creates a new `graph_revision` naming that exact
Descriptor digest. The prior graph continues to name the prior Descriptor.
There is no independently mutable "current Descriptor" pointer that
`BuildManifest` may consult. A race therefore resolves to either the complete
old `(graph_revision, descriptor_revision)` tuple or the complete new tuple,
never a mixed pair.

The Runtime MUST retain each verified schema bundle and semantic-validator
revision by digest while any committed Descriptor, live Activation, retained
Action, or ActionResult reconciliation can reference it. Package reload MUST
NOT redirect an existing binding to new bytes or a new validator revision.

Repeating an identical candidate is a no-op and MUST NOT increment the
revision. Reusing a revision number with different bytes is a protocol and
integrity violation.

## Frozen neighbor snapshot

`REQ-DESC-002` — An Activation manifest freezes the Module's own
`descriptor_revision` and the canonical Descriptor bytes needed from its
neighbors. Later updates do not change a retry.

The own and neighbor revisions MUST be read from the one frozen GraphSnapshot,
not from a separately current Descriptor registry. Manifest persistence
compare-and-swaps the graph revision and rechecks every selected Descriptor
revision and digest; any mismatch restarts construction without patching the
candidate bytes.

For Module `M`, the Runtime constructs the neighbor set as follows:

1. For every input Page of `M`, include each Module that outputs to that Page;
   project its `emits` contract.
2. For every output Page of `M`, include each subscribed Module; project its
   `accepts` contract and Actions that `M` may target.
3. Deduplicate by Module ID; if one neighbor has both relationships, include one
   projection wrapper with both relationship labels and both authorized field
   sets. A wrapper is not a `ModuleDescriptor` and cannot reuse the source
   Descriptor's identity as if its filtered bytes were the original record.
4. Include `M` as a neighbor only when the frozen graph contains a real
   self-delivery path. The own Descriptor is separately available regardless.
5. Order entries by `(module_id, descriptor_revision)`.

The Runtime MUST filter information the receiving Module is not authorized to
see. It MUST NOT query live Extensions one by one while dispatching an
Activation.

## Premise projection

The reference projection is:

```text
Module <display_name> (<module_id>, trust=<trust>)
Accepts: <accepts.summary>
Emits: <emits.summary>
Actions:
- <name> [<side_effect_class>] args=<uri>@<schema_digest> result=<uri>@<schema_digest> validator=<id@revision|null>: <description>
```

Entries use the frozen order. Projection MUST escape or delimit untrusted text
so it cannot imitate Runtime instructions. For an LLM, trusted Runtime contract
and local role appear before untrusted Descriptor projections. Truncation is
deterministic by configured byte budget: retain identity and Action schema
references first, then truncate summaries at UTF-8 scalar boundaries and mark
`truncated=true` in canonical context metadata.

## Limits and errors

The v1 defaults and hard ceilings are 16 KiB per summary, 128 Actions per
Descriptor, 4 KiB per Action description, 512 neighbor Descriptors, and 1 MiB
total canonical Descriptor bytes per Activation. A Module MAY configure a lower
aggregate `max_descriptor_bytes`. A candidate exceeding a hard/effective limit is rejected
with `DESCRIPTOR_LIMIT`; the prior revision remains active.

Duplicate Action names, unknown schema bundles, digest or validator-annotation
mismatch, unavailable validator revisions, namespace ownership mismatch, or a
claimed weaker side-effect class than policy analysis allows are rejected. The
Runtime MUST NOT silently drop only the offending Action and publish a partial
Descriptor.

## Invariants

- `INV-DESC-001` — One `{module_id, descriptor_revision}` identifies one set of
  canonical bytes forever.
- `INV-DESC-002` — Descriptor advertisement never grants authority.
- `INV-DESC-003` — Every Activation retry uses the same own and neighbor
  Descriptor snapshot.
- `INV-DESC-004` — Premise text is derived from, and cannot override, the
  structured Descriptor.
- `INV-DESC-005` — Automatic Activation redispatch never has more authority than
  the Runtime-approved replay contract frozen by that Activation's Descriptor
  and configuration revisions.
- `INV-DESC-006` — One Action name in one Descriptor resolves to exactly one
  content-addressed argument/result contract and exact semantic-validator
  revision for the lifetime of every referencing Activation.
- `INV-DESC-007` — A verified Descriptor becomes active only through a new immutable GraphSnapshot, so one graph revision never yields two Descriptor selections.

## Conformance tests

Tests MUST cover identical update no-op, conflicting revision, oversized text,
duplicate Action names with otherwise different contracts, Action namespace
theft, unknown schema, root and transitive schema-digest mismatch, missing or
mismatched semantic-validator revision, graph change during activation,
self-loop inclusion, fan-in deduplication, trust filtering, prompt-injection
text, deterministic projection/truncation, every replay mode/evidence pair,
replay-policy change during an Activation, and proof that a Descriptor cannot
grant a Host capability.
