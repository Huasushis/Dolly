# Configuration and Graph Revisions

Status: normative for instance configuration, optimistic concurrency, and graph snapshots.

## 1. Configuration document

An instance configuration is a strict JSON document with a versioned API schema. The control plane **MUST** reject duplicate object keys, unknown fields where the active schema is closed, invalid Unicode, invalid identifiers, and values outside schema bounds. YAML, TOML coercion, comments, NaN, infinity, and implementation-specific JSON extensions are not part of the normative format.

The document **MUST** contain an `api_version`, a `kind`, instance metadata, and a `spec`. Runtime state such as Page cursors, Activation leases, health, process IDs, and generated secrets **MUST NOT** be written into the desired configuration.

The control plane **MUST** preserve the submitted JSON document for audit and **MUST** also derive a normalized semantic representation. The normalized representation:

- orders object keys deterministically;
- preserves array order where order is semantically declared;
- uses stable configured IDs as object identity;
- resolves defaults explicitly;
- excludes presentation-only fields from graph semantics where the schema declares them presentation-only; and
- has a cryptographic digest recorded with the revision.

JSON Schema's `default` keyword is an annotation and is never an input to
normalization. Dolly v1 Extension-level and Module config schema bundles MUST
NOT contain a JSON member named `default` at any depth (including under a
property-name map, to keep validation mechanical and unambiguous). Every
Extension-visible value is either
present in the submitted Extension/Module objects, inherited by the shallow
overlay below, or inserted by an explicit versioned Dolly config-normalizer
rule stated outside JSON Schema. The current v1alpha1 Runtime schema makes all
safety-relevant values required and defines no implicit Extension default. A
package MAY ship a UI template, but template values have no authority until
submitted and committed. Descriptor-template normalization is the separate
explicit rule in the Module Descriptor chapter and does not make schema
annotations executable.

A display-name change does not change object identity. Changing a Page, Module, Extension alias, or other stable configured ID is delete-plus-create and **MUST** satisfy the corresponding migration and backlog rules.

### 1.1 Extension and Module configuration resolution

An Extension package declares two different closed configuration contracts in
its signed manifest:

- the Extension-level `config_schema` validates the object at
  `spec.extensions[extension_alias].config`; and
- each Module type's `config_schema` validates the resolved configuration for
  every Module instance of that type.

Each schema binding consists of the absolute `$id` URI of a whole schema
resource contained in the verified package, with no query or fragment, and the
SHA-256 digest of the complete transitive
schema-resource closure, using the canonical `dolly.schema-bundle/v1` rule in
[Module Descriptor](../01-architecture/06-module-descriptor.md). Resolution is
confined to the already verified package: network retrieval and references
outside that package are forbidden, and the signed package digest independently
pins every package byte. A URI, bundle digest, package digest, or transitive
reference mismatch rejects the configuration before any Extension process
executes. The bundle envelope's `root` MUST equal that absolute manifest
binding URI exactly, and the complete configuration value is validated against
that whole root resource. Relative ConfigSchemaBinding URIs are invalid; config
bindings deliberately do not reuse the Action-contract fragment mechanism.

For Module `m` referencing Extension alias `e`, the normalizer computes
`effective_config(m)` by one deterministic, **shallow** overlay:

1. begin with every top-level member of `e.config`;
2. for each top-level member in `m.config`, replace the member of the same name
   in its entirety, or insert it if absent; and
3. emit the resulting object in JCS form and hash those UTF-8 bytes.

There is no recursive object merge. Arrays are replaced, not concatenated.
JSON `null` is an ordinary replacement value, not a delete instruction. An
absent member inherits; a present member always replaces. Consequently every
conforming implementation derives the same object and digest without an
Extension-defined merge callback.

After overlay and before Module-schema validation, the normalizer MUST reject
an `effective_config` with more than 1,024 top-level members. The two source
objects each have the same individual ceiling, but disjoint keys can exceed the
consumer limit after overlay; candidate validation MUST perform this resolved
count and MUST NOT defer failure to instantiate, prepare, or Manifest encoding.

`REQ-CFG-005` — Every resolved Module `effective_config` MUST contain at most
1,024 top-level members, and the control plane MUST reject an over-limit shallow
overlay before committing its configuration revision.

The control plane first validates `e.config` against the Extension-level
schema, then validates every `effective_config(m)` against that Module type's
schema. It stores the exact Extension object, effective object, their JCS
digests, both schema-bundle digests, verified package digest, and
`config_revision` in the resolved revision. A change to an Extension-level
object affects every process initialized for that Extension alias, including a
per-Module process whose final overlaid value happens to be unchanged, because
the process-level consumer observed the changed object.

`extension.initialize` receives the frozen Extension-level object and its
revision/digests. `module.instantiate` and `module.prepare_config` receive only
the frozen effective Module object and its revision/digests. They never receive
two objects to merge. Every Activation Manifest materializes that same
effective object and the exact schema-bundle digest, while its retained
configuration revision continues to bind the verified package digest. Thus
redispatch after update or restart cannot read newer configuration or schema
bytes accidentally. A Host MAY deduplicate the stored canonical bytes
internally, but the wire value and digest remain part of the immutable Manifest
semantics.

For v1, changing the Extension-level object requires a new Extension process
generation for every affected per-Extension or per-Module host.
`module.prepare_config` is
permitted only when the Extension-level object and its schema binding are
unchanged and the package declares that the Module type supports transactional
in-generation reconfiguration. Otherwise the transaction uses generation
replacement, snapshot/migration where required, and the ordinary cutover
fences. No configuration field is allowed to exist without one of these
declared validation and delivery consumers.

## 2. Revisions

Each instance has two monotonically increasing Core safe-JSON-integer revisions:

- `config_revision`, advanced exactly once for every successfully committed normalized configuration change; and
- `graph_revision`, advanced exactly once when the effective Page/Module/subscription/routing graph or any Descriptor/capability-policy revision pinned by that graph changes.

Both begin at 1 for the first committed configuration. Revision 0 means no committed configuration. Revision values **MUST** be persisted and encoded as JSON integers in `0..9007199254740991`. The control plane **MUST** stop admission with `CORE_SEQUENCE_EXHAUSTED` before it would reuse or exceed that range.

A transaction that changes only a non-graph setting advances `config_revision` and retains `graph_revision`. A transaction that changes graph semantics advances both in the same Host database transaction. Revisions never decrease and are never reused, including after rollback. A rollback is a new configuration transaction with new revision values.

The Host **MUST** persist, for every committed revision:

- submitted and normalized configuration digests;
- schema and normalizer versions;
- parent config revision;
- graph revision;
- author/principal and approval record;
- transaction ID and timestamp; and
- a redacted diff.

## 3. Reading configuration

Every read response **MUST** return the active `config_revision`, `graph_revision`, normalized digest, and configuration API version. A client that plans to update configuration **MUST** use the returned `config_revision` as its optimistic concurrency base.

The control plane MAY retain prior documents according to policy, but a retained secret reference **MUST NOT** reveal the secret value. Historical configuration is sensitive audit data and follows the operations retention policy.

## 4. JSON Patch update request

Updates use RFC 6902 JSON Patch against one exact active document:

```json
{
  "operation_id": "0198ab31-6c44-7e8a-b2bb-000000000071",
  "base_revision": 42,
  "principal": "runtime-admin",
  "patch": [
    {
      "op": "replace",
      "path": "/spec/modules/main-brain/config/model",
      "value": "example-model"
    }
  ],
  "reason": "Move the module to the validated profile",
  "expected_impact": "One LLM module restart",
  "rollback_condition": "Health probe fails",
  "destructive_dispositions": []
}
```

The control plane **MUST** compare `base_revision` before applying any patch operation. A mismatch returns `revision_conflict` and the current revision; the server **MUST NOT** automatically rebase the patch.

Patch evaluation is atomic over the in-memory base document. Failure of any operation rejects the entire patch. JSON Pointer resolution follows the exact base document. Identity-bearing collections in the v1 configuration are objects keyed by stable ID and MUST be addressed by that key, never by a positional array index. Arrays exist only for semantically ordered or set-like leaf values; an array index has meaning only at the stated base revision. Clients **SHOULD** include `test` operations before editing an array, and control-plane-generated patches **MUST** address identity-bearing collections by stable ID.

The following are forbidden regardless of JSON Patch syntax:

- changing a revision or transaction record directly;
- inserting secret values where only `secret_ref` is allowed;
- modifying generated Runtime state;
- addressing a path outside the instance document;
- changing immutable data roots online; and
- adding schema-unknown executable, frontend, or capability fields.

Authorization **MUST** be evaluated on every affected JSON Pointer after expansion of `move` and `copy`. A permitted parent path does not implicitly authorize all descendants.

An `operation_id` is idempotent. Repeating it with the same base revision and patch digest returns the existing transaction/result. Reusing it with different input returns `revision_conflict`.

## 5. Validation pipeline

Before a transaction can prepare participants, the control plane **MUST** run, in order:

1. strict JSON decoding and API-version selection;
2. core JSON Schema validation;
3. normalization and stable-ID uniqueness checks;
4. Extension-specific schema validation without executing unverified code;
5. graph semantic validation;
6. capability and security-policy validation;
7. resource/quota validation;
8. diff classification and affected-set calculation; and
9. approval-policy classification.

Graph validation **MUST** reject dangling Page/Module/Extension references,
duplicate stable IDs, a pair of installed Extension package IDs where one is a
dot-label prefix of the other, unsupported Module types, incompatible
Part/Action contracts when statically knowable, impossible subscription start
policies, and graphs whose configured safety limits are absent or invalid.
Cycles are allowed; a cycle **MUST NOT** bypass trace, activation-rate, byte, or
backlog limits.

Resolved limit validation MUST additionally enforce all cross-field relations
that JSON Schema 2020-12 cannot express: `retry_base_ms <= retry_cap_ms`,
`max_block_bytes <= every Module.max_input_bytes`, and for every Module
`max_input_bytes + max_descriptor_bytes +
len(UTF8(JCS(effective_config(module)))) +
manifest_structural_reserve_bytes <= max_frame_bytes`.
`manifest_structural_reserve_bytes` is not a user estimate:
the normalizer MUST derive it from that Module's maximum occurrences, input
Pages, cursor spans, gap records, identifier lengths, and the exact v1 envelope
encoding, then store the derived value in the resolved configuration. Frozen
neighbor descriptors have their separate aggregate `max_descriptor_bytes`
budget. The Runtime still checks the exact complete canonical request before
persisting a Manifest. `asset.max_inline_base64_chars + 65536` MUST also fit
`max_frame_bytes`. A configuration that can admit a Block but cannot carry it
in a one-Block Activation is invalid; the Runtime MUST NOT defer that discovery
until the Page head is blocked.

Every persisted Activation Manifest records digest-covered
`required_frame_bytes` and `required_frame_nesting_depth` bounds for all legal
redispatches of its immutable bytes. A package, hosting, protocol-limit, or
generation change MUST validate, per affected Module, every Manifest that can
legally receive a future `module.activate`: `ready`, `leased`, `fencing`,
`retry_wait`, and a releasable quarantine without an authoritative result.
`result_staged`, `commit_blocked`, and quarantines with authoritative staged
results are excluded because Core applies their exact bytes without reinvoking
the Extension. Before the candidate may become current or `Ready` for a Module,
its negotiated limits MUST meet both bounds for that Module's redispatchable
Manifests. It MUST also prove support for every Manifest's exact
`effective_config_schema_digest` and complete `effective_config`, plus every
retained schema bundle and semantic-validator revision in its targeted Action
bindings. An incompatible candidate may initialize and may host unrelated
compatible Modules, but is rejected for the affected Module unless an old
compatible generation remains authoritative until the blocker is resolved.
The transaction MUST NOT make a Manifest smaller by rewriting, truncating,
re-batching, changing its identity, substituting current configuration, or
rebinding an ActionContract.

If this incompatibility is discovered only after the Host commit point, affected
work remains fenced and configuration recovery MUST converge to a compatible
target or enter `Degraded`; it MUST NOT select the incompatible generation and
hope dispatch succeeds.

For Model Gateway configuration, every `profiles` map key MUST equal its
contained `profile_id`, every referenced profile/credential in `rate_limits`
MUST exist, both a per-profile and per-credential limit MUST cover each enabled
profile, and `retry_base_ms <= retry_cap_ms`. Duplicate rate-limit scope keys are
invalid rather than order-dependent.

For Asset configuration,
`replica_retry.retry_base_ms <= replica_retry.retry_cap_ms`; the retry policy is
materialized even when the replica is disabled so enabling a validated target
cannot introduce a binary-local default.

Every Core block/trace/Activation safety limit MUST appear explicitly in the
resolved `limits` or Module `activation` object. The control plane enforces the
v1 schema hard ceilings and rejects a missing value; implementations MUST NOT
fall back to a compile-time default after normalization.

Validation is side-effect free. Successful validation does not reserve resources and does not make the target revision visible.

## 6. Immutable graph snapshot

Each `graph_revision` identifies one immutable normalized graph snapshot. The snapshot **MUST** define:

- Page identities and durability classes;
- Module identities and Extension aliases/types;
- input subscriptions and their start policies;
- output routing;
- self-delivery policy;
- per-Page and per-Module limits; and
- descriptor and capability-policy revisions used to validate routing.

An Activation manifest **MUST** record the exact config and graph revisions used to select inputs and route its result. A retry of that manifest uses the same revisions unless the old transaction explicitly cancels it before its commit point and creates a new manifest under the new graph.

## 7. Affected set and graph cutover

For a graph change, the affected set **MUST** include:

- every added, removed, or reconfigured Module;
- every Module whose input subscription changes;
- every Module whose output routing changes;
- every producer or consumer of a Page whose durability, quota, or retention semantics change; and
- any participant required by an Extension-declared stronger dependency.

The affected set determines validation, retained revision state, and which
participants may require prepare. A graph-only change **MUST NOT** quiesce a
Module merely because its routes changed: an already persisted Activation owns
its old snapshot and MAY commit after cutover. The Host MUST retain every old
Page, descriptor, policy, and routing object needed by such an Activation until
it is terminal. Its output goes only to the old frozen Page set, never to the
new graph.

Quiescence and generation fencing are REQUIRED only when the transaction
replaces Extension-owned state/process generation, immediately revokes
authority, performs a destructive disposition, or cannot retain an old
revisioned participant safely. In that case an old Activation either commits
before the fence or is safely cancelled before its commit point; cancellation
is terminal and later scheduling creates a new manifest from unchanged cursors.

The active graph pointer changes atomically with `graph_revision` in the Host database. After that point:

- new Activation manifests use only the new graph;
- results from Activations explicitly cancelled/fenced for cutover are rejected by their lease fence; graph-revision mismatch alone **MUST NOT** invalidate an otherwise live frozen Activation manifest;
- already committed Page Delivery records remain on their original Pages and are not moved or duplicated; and
- newly created subscriptions use their explicitly configured start position.

## 8. Removal and backlog disposition

Removing a durable subscription, Module, or Page can strand unconsumed data. The default behavior **MUST** be to reject the change while a durable backlog, pin, Block reference, Asset reference, or in-flight operation would become unreachable.

A destructive update MAY include an explicit disposition such as archive, transfer to another subscriber, dead-letter, or audited discard. The disposition **MUST** identify the exact sequence range and estimated bytes, require the configured approval level, and complete before cutover. Silent backlog deletion is forbidden.

Removing a Module does not automatically delete its committed Blocks, Memory records, Assets, or audit history. Their independent retention and reference rules apply.
Its ModuleId tombstone and ModuleStorageScopeId mapping are retained for the
identity-adoption and audit period. A later unrelated Module MUST use a new
ModuleId and a new storage scope; deleting desired configuration is not consent
to attach old Extension state to a new object.

## 9. Descriptor and policy revisions

Module Descriptor, capability, and trust-policy changes **MUST** have revisions. An Activation **MUST** receive a self-consistent descriptor/policy snapshot. A descriptor notification is only a proposal to store a verified inactive revision; it does not mutate an in-flight Activation or the active graph. Making that proposal active is a graph-semantic configuration change: one Host transaction advances both config and graph revisions and installs the new GraphSnapshot that names the exact Descriptor/policy digests. `BuildManifest` reads only those graph-pinned revisions and compare-and-swaps them at persistence.

If a security-policy update revokes authority, the Host MAY fence affected in-flight calls immediately. Such emergency revocation **MUST** be journaled and takes precedence over ordinary configuration quiescence.

## 10. Conformance properties

Implementations **MUST** test that:

- a base-revision mismatch never partially applies a patch;
- revisions never decrease or reuse a value;
- graph cutover and active graph revision are atomic;
- stale Activations cannot route into the new graph;
- committed Deliveries are neither moved nor duplicated by reconfiguration;
- destructive removal requires an exact explicit disposition; and
- normalization produces the same digest on Linux and Windows.

## 11. Stable requirements and invariants

- `INV-CFG-001` — Config and graph revisions are monotonically increasing, never reused, and change only at the Host commit point.
- `INV-CFG-002` — One graph revision names one immutable normalized routing snapshot.
- `INV-CFG-003` — A frozen Activation retains its graph/config revisions and output routing; graph mismatch alone does not rewrite it.
- `REQ-CFG-001` — A JSON Patch applies only to its exact base revision and is never silently rebased or partially applied.
- `REQ-CFG-002` — Removing reachable durable state requires an exact approved disposition; silent backlog deletion is forbidden.
- `REQ-CFG-003` — Module effective configuration is the JCS-digested shallow
  overlay defined in section 1.1; recursive merge, array concatenation, and
  null-as-delete are forbidden.
- `REQ-CFG-004` — Every Extension and effective Module configuration is
  validated, revisioned, delivered, and frozen with exact schema and package
  digests; an old Manifest never observes a newer configuration.
