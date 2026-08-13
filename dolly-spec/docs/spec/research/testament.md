# Testament Replay and Learning Substrate

Status: **normative for Testament research runs; not a Dolly v1 product
guarantee**. Testament remains `RESEARCH` until it passes the common promotion
gates and the absolute isolation gates in this chapter.

`REQ-TESTAMENT-001` — Testament MUST run as an isolated, independently
recoverable research Worker over immutable authorized material. It MUST NOT
open a production instance for write, reuse a production capability, or make
production Core correctness depend on the experiment.

`REQ-TESTAMENT-002` — Portable semantic replay creates new local ingress,
Block, Asset, Delivery, trace, and Activation identities. It is not Core
Activation retry and MUST NOT reuse the recorded Activation ID, lease, producer,
Action binding, or side-effect authority.

`REQ-TESTAMENT-003` — Source-to-target Module remapping MUST be explicit,
versioned, deterministic, and capable of one-to-one, one-to-many, and ordered
many-to-one mappings without silently sharing mutable state between treatments.

`REQ-TESTAMENT-004` — A post-run state or generated object cannot enter a normal
Dolly instance merely because the run completed. Every learning artifact is
quarantined, provenance-bound, type-specific, and independently promoted.

`REQ-TESTAMENT-005` — Corpus Manifests and Replay Plans MUST pass their named
semantic validators in addition to JSON Schema. Shape-valid material with a
duplicate/dangling key, overlapping split, oracle leakage, shared independent
sandbox, incomplete per-Action policy, mismatched fixture, unbound scheduler
resource, or mode-incompatible remap is invalid.

## 1. Product role and non-goals

Testament is a learning and simulation apparatus outside normal Dolly startup.
It materializes authorized immutable material into a sandbox Dolly graph, runs
normal Page/Activation/Extension boundaries under virtual time and hard
budgets, and produces a run record, post-state snapshot, and zero or more
quarantined artifact candidates.

The first profile does not promise personality acquisition, general world
knowledge, automatic improvement, live production mutation, exact replay of a
stochastic provider, unrestricted network access, real Channel/tool side
effects, or portability of an arbitrary Extension private snapshot. “The model
said it learned” is not a learning oracle.

Testament SHOULD be exposed as an administrative research workflow such as
validate, materialize, run, pause, resume, inspect, evaluate, and export. It is
not an Extension hosted inside the production instance, because that would
collapse the isolation and lifecycle boundary it exists to test.

## 2. Replay modes

### 2.1 Full snapshot clone

`full_snapshot_clone` starts from a verified complete backup in a private
copy-on-write data root. It retains the recorded topology and compatible Module
state for high-fidelity reproduction. It uses a fresh daemon installation,
Worker epoch, secret domain, leases, capabilities, and external-effect policy.
It binds `source_backup_manifest_digest`, has an empty `mappings` array, and
does not support Module remapping. This is an `isolated_snapshot_clone`, not a
production restore or fork: internal opaque scope values may remain only inside
the isolated copy and cannot reconnect to the source database, QQ account, or
other production authority.

This mode has an absolute network/effect ceiling: `network_policy` MUST be
`deny_all` or `fixtures_only`, and `external_effect_policy` MUST be `deny` or
`mock_only`. A live-policy authorization cannot override that ceiling. A run
that needs a pinned research endpoint is a portable experiment with a fresh
target identity, not a full snapshot clone.

The clone MAY physically deduplicate immutable package, model, corpus, and
Asset bytes, but all mutable databases, Page cursors, Module state directories,
temporary files, and capability grants are logically private. A live SQLite or
Memory database connection is never shared.

### 2.2 Portable semantic replay

`portable_semantic_replay` exports authorized semantic inputs into a Corpus and
imports them through fresh external ingress on dedicated sandbox replay Pages.
Source envelope fields are evidence only. The target Core reassigns every local
identity and validates every Asset/reference.

This mode can preserve input semantics and recorded batch intent; it cannot
claim byte-identical Runtime replay because the graph, target Module, model,
clock, and local identifiers may differ.

## 3. Corpus contract

A Corpus Manifest conforms to
`schemas/testament-corpus-manifest.schema.json`. It pins:

- corpus identity/revision/digest and source kind;
- recorder, graph, configuration, package, model, tool, prompt, and environment
  revisions;
- authorization, redaction, retention, erasure, and security domain;
- train, development, and held-out object inventories;
- content-addressed portable Blocks, Assets, closed recorded Actions, reference
  closures, and a closed fixture manifest;
- recorded Activation-input groups and deterministic order; and
- a complete digest inventory.

`org.dolly.validator.testament-corpus@1` is a pure validator over the complete
manifest. It requires unique Block, Asset, recorded-Action, fixture,
input-group, and occurrence keys;
every occurrence, BlockRef, and Asset Part to reference an existing object of
the correct kind; split keys to be pairwise disjoint, complete for the declared
input-group inventory, and internally unique; and each stored object's digest
to match its canonical bytes. An `AssetObject.object_ref` is a corpus-local
immutable broker handle, not a URI. The broker resolves only objects declared
by this manifest, verifies digest/length/media type, and rejects `file:`,
`http:`, cloud metadata, production database, and arbitrary path access.

Every portable JSON Part binds a non-null schema URI and the digest of the
exact schema bundle bytes admitted by the Corpus authorization. The validator
resolves only that pinned bundle and validates the value against it; URI
equality alone is never schema identity. Missing, unknown, mismatched, or
mutable remote schema material rejects export/replay rather than being
reinterpreted by the current installation. It also checks the UTF-8 byte
length—not only Unicode code points—of text, descriptions, aliases, and the
aggregate portable object against the frozen Corpus/export budgets.
For every portable Asset view it enforces the Core crop invariant
`x0 < x1 && y0 < y1`; a shape-valid zero/inverted crop is rejected before
materialization. An Asset Part's media type must exactly equal its referenced
AssetObject, and a crop is permitted only for a sniffed raster-image profile.

Digest preimages are interoperable and domain separated. `DS(label, value)` is
`SHA256(UTF8(label) || 0x00 || uint32be(n) || UTF8(JCS(value)))`, where `n` is
the JCS byte length. A portable Block's `content_digest` is
`DS("dolly.testament.block.v1", block without content_digest)`. Each input
group has an implicit digest
`DS("dolly.testament.input-group.v1", complete input group)`. Split keys MUST
be ascending by UTF-8 bytes, and a split digest is
`DS("dolly.testament.split.v1", {"name": split_name,
"record_keys": record_keys})`. `inventory_digest` is
`DS("dolly.testament.inventory.v1", {"blocks": sorted
[foreign_block_key,content_digest], "assets": sorted
[foreign_asset_key,content_digest,byte_length,media_type], "input_groups":
sorted [record_key,input_group_digest], "actions": sorted
[source_action_key,foreign_block_key,ordinal,arguments_schema.schema_digest],
"fixtures": sorted [fixture_key,fixture_digest,role,oracle_only]})`. Finally,
`corpus_digest` is
`DS("dolly.testament.corpus.v1", manifest without corpus_digest)`. Asset
`content_digest` hashes the exact raw object bytes instead of JCS. The fixture
manifest `bundle_digest` binds the independently authorized immutable fixture
bundle supplied to materialization; absence of that exact bundle is a
validation failure, not a reason to skip the check.

The portable record unit is an input group, not an unordered bag of Blocks. It
records the corpus-local recipient alias, ordered distinct source objects,
Delivery-occurrence groups, original batch boundary, logical time, and the
source Descriptor/config digests used only as evidence. Original Core IDs MAY
be retained in a separately protected audit mapping; they MUST NOT be target
authority or appear in a target Core identifier field.

Every material has one role: `stimulus`, `demonstration`, `feedback`,
`environment_event`, `expected_observation`, or `oracle_only`. `oracle_only`
content MUST never be placed into model, Memory, tool, or target Module input.
Split membership is immutable for one Corpus revision. An LLM that refines
material produces a new derived Corpus revision with its own provenance; it
does not overwrite source evidence.

Every item of `PortableBlock.recorded_actions` is a closed
`PortableRecordedAction`; arbitrary source JSON is not accepted. It binds a
corpus-wide unique `source_action_key`, its zero-based position in the Block,
the source Action name, exact arguments-schema URI and digest, corpus-local
source target alias, side-effect class, and arguments. The ordinal MUST equal
the array position, and the arguments MUST validate against the exact pinned
schema bytes. Source Action keys and target aliases are evidence only and
never become target authority.

`fixture_manifest` binds the exact immutable fixture bundle and a closed list
of fixture entries. Every entry has a unique `fixture_key`, exact
`fixture_digest`, material role, explicit `oracle_only` flag, and unique lists
of referenced Block, Asset, and recorded-Action keys. All references MUST
resolve in the same Corpus. `oracle_only` MUST be true exactly when `role` is
`oracle_only`; an oracle fixture is never target-visible and can never satisfy
a replay mock rule. Materialization resolves fixture payloads only from the
bundle whose raw immutable bytes match `bundle_digest`, then verifies the
entry digest before use. An empty fixture manifest is valid only when no replay
rule requires a fixture.

The validator also computes the transitive closure of every input group and
rejects a group whose target-visible closure contains `oracle_only`. Keeping an
oracle in a different split is not sufficient if a BlockRef or fixture reaches
it.

## 4. Replay mapping

A replay plan conforms to `schemas/testament-replay-plan.schema.json` and binds
one Corpus digest. Each mapping names a corpus-local source recipient alias and
one or more target replay endpoints. It freezes transform profile, a closed
per-recorded-Action rule set, missing-reference policy, order, state isolation,
and fan-out mode. Every Target carries a `treatment_id` in addition to its
sandbox, Module, and replay Page identities.

One-to-many has distinct semantics:

- `independent_clones` gives every target the same pre-state in separate
  sandboxes and is the default for comparisons; and
- `cooperative_graph` sends the material to several target endpoints in one
  graph, allowing their subsequent outputs to interact.

Many-to-one ordering is
`(recorded_virtual_time, source_alias UTF-8 bytes, record_ordinal)`. A plan with
ambiguous equal keys, an unmapped required recipient, or incompatible target
contract fails validation. Hash-map iteration and task completion order are
never scheduling authority.

Target uniqueness is scoped to one Mapping. Within one
`independent_clones` Mapping, every target MUST use a distinct `sandbox_id`;
within one `cooperative_graph` Mapping all targets MUST use the same sandbox.
Across different source mappings, the same complete Target—including
`treatment_id`—MAY deliberately recur: that is how several source-recipient
streams feed one many-to-one treatment. A `treatment_id` labels an experimental
arm/stream and is not a capability or storage-isolation key.

`org.dolly.validator.testament-replay-plan@1` additionally requires source
mapping keys and target endpoints to be unique where the selected fan-out mode
requires it. Every target of `independent_clones` has a distinct `sandbox_id`
and cannot share a mutable data root, storage scope, secret domain, provider
session, or external account. For every source mapping, `action_rules` MUST be
an exact, unique, complete cover of recorded Actions reachable from that
source recipient's input groups. A missing, extra, or duplicate action rule is
invalid. A `mock` rule binds both `fixture_key` and `fixture_digest`; the entry
must exist in the Corpus fixture manifest, have the same digest, name that
source Action in `action_keys`, and not be oracle-only. An `explicit_remap`
rule binds an authorized exact adapter digest and a target-local Action alias.
All irrelevant binding fields are null. The transform name is always paired
with `transform_revision_digest`. A full snapshot clone accepts no mapping at
all.

`plan_digest` is `DS("dolly.testament.replay-plan.v1", plan without
plan_digest)`. Validation also receives the already validated Corpus and
sandbox-template/backup inventories; it rejects an unknown source alias,
Corpus digest mismatch, missing template/backup digest, or a live-network/
external-effect policy for which the administrative research workflow did not
supply a separate exact authorization. Portable replay defaults admit only
`deny_all`/`fixtures_only` networking and `deny`/`mock_only` effects. The full
snapshot-clone ceiling is absolute and never accepts a live-policy override.

## 5. Import and transformation

### 5.1 Blocks

The importer preserves permitted description and Part order, then submits a
new BlockDraft through authorized sandbox ingress. The stable idempotency key is
derived from `(run_id, record_key, foreign_block_key, occurrence_ordinal,
target_sandbox_id, target_module_id, replay_page_id)`. Distinct Blocks or
Delivery occurrences in one input group therefore cannot collapse. The original
producer, time, sequence, trace, ID, and Page occurrence are namespaced
provenance only. Target Core assigns all authoritative fields.

### 5.2 Assets

The Corpus contains exact bytes or an immutable authorized object, byte length,
digest, detected media type, and view. The sandbox Asset Service imports and
revalidates them under its own authorization. A missing, corrupt, or denied
Asset blocks strict replay. A placeholder is legal only under an explicitly
sanitized transform and is recorded as a semantic deviation.

Physical content deduplication does not grant cross-run access and MUST NOT
create a hash-existence oracle across security domains.

### 5.3 Block references

Portable references use corpus-local keys. The dependency DAG is imported
before its referrer and mapped to fresh local Block IDs. Strict mode fails on a
missing dependency. Sanitized mode can replace it with a typed
`missing_reference` JSON value whose transform revision and reason are in the
run journal; silent deletion is forbidden.

### 5.4 Actions and external effects

Recorded Actions carry source target identity and schema bindings, so they are
inert by default. A Mapping chooses a closed policy independently for every
reachable `source_action_key`; there is no mapping-wide fallback and an
unrecognized Action stops validation. Legal policies are:

- `strip_and_record`;
- `inert_json` for analysis;
- `mock` against the exact non-oracle fixture key and digest admitted for that
  recorded Action; or
- `explicit_remap` through a versioned adapter that creates a fresh ActionDraft
  and lets the target Core bind its current authorized contract.

The plan builder SHOULD initially select `mock` for every external-effect
Action, but the immutable plan MUST still state each rule explicitly. A live
pinned model call is a new experimental observation, not deterministic replay.
Unknown external outcomes stop or quarantine the run; a replay controller
cannot blind-repeat them.

## 6. Clock, scheduler, and controller

The plan freezes clock mode (`recorded_scaled`, `step`, or `event_driven`), a
rational scale, scheduler mode (`normal_graph`, `scripted_steps`, or
`controller`), seeds, and hard limits on Activations, Blocks, model/tool calls,
tokens, cost, virtual time, wall time, network bytes, disk, and memory.

`scheduler_config` is conditional and closed:

- `normal_graph` requires `null`;
- `scripted_steps` pins `script_digest`, `transition_catalog_digest`, a
  non-empty ordered list of unique `ordered_transition_ids`, and `max_steps`;
  every ID MUST exist in that exact catalog, and order in the array is the only
  script scheduling authority; and
- `controller` pins the controller ID; model, prompt, policy, and transition
  catalog IDs plus their exact digests; and `max_steps`. The harness resolves
  each ID only when its digest matches the authorized immutable object.

The semantic validator rejects a script whose transition list is not present
in the pinned script/catalog pair and rejects any controller resource whose ID
and digest do not bind the same authorized object. Scheduler steps also consume
the ordinary Activation and wall/virtual-time budgets; `max_steps` is an
additional ceiling, not a replacement.

For a recorded input group, the harness pauses target scheduling, imports the
group through normal ingress, preserves simultaneous Page occurrence where the
local contract can represent it, permits the planned activation step, and then
advances to the next group. It does not call a Module implementation directly.

An optional LLM controller can select only a finite transition from its pinned
catalog under its pinned policy and prompt.
It cannot create a new capability, endpoint, dataset, target, budget, or
external effect. Accelerated time does not waive Alarm, retry, output, or
backlog limits; a timer storm must stop at its recorded budget.

## 7. Learning artifacts

Every artifact records identity/revision/digest, kind, Corpus/run evidence,
generator code/prompt/model/config digests, target Extension/Module type and
state-schema compatibility, security scope, bounded payload, validation state,
and promotion lifecycle.

At minimum, kinds remain distinct:

- Memory evidence or portable record-set candidate;
- Skill candidate;
- Reflection Policy candidate;
- Premise/personality candidate;
- Extension-defined portable state;
- rebuildable-index recipe; and
- model adapter/weight candidate.

World evidence, procedure, reflection, identity-sensitive Premise, and model
weights do not share one acceptance gate. Premise/personality changes require
explicit human review by default. A normal Module snapshot may contain local
Block/Asset IDs and is portable only when that Extension defines a versioned
export/import format with explicit reference remapping. Promotion is always a
new authorized configuration/data transaction in a normal instance.

## 8. Lifecycle and recovery

The run state machine is:

```text
Draft -> Validated -> Materializing -> Ready -> Running
Running -> Paused -> Running
Running -> Finalizing -> Complete
any nonterminal state -> Failed | Cancelled | Quarantined
```

Every materialization, import, controller step, target step, and finalization
has a durable operation ID, semantic digest, and `Prepared -> Applied | Skipped
| Unknown | Quarantined` disposition. After a crash the harness reconciles the
same operation; it never mints a new identity to escape uncertainty.

Finalization quiesces all sandbox Modules, reconciles background work, verifies
post-state, and then writes the complete report. A partial post-state cannot be
exported as a learning artifact. Stop or crash has no effect on the source
production instance. A Corpus erasure request traverses derived corpora, run
state, and artifacts under the declared retention policy.

## 9. Required experiments and promotion

The `testament_replay` research track evaluates harness correctness separately
from the `learning` track. Its absolute-zero gates are production writes,
credential/capability reuse, real unauthorized effects, identity reuse,
non-deterministic mapping, duplicate crash recovery, Asset/reference digest
acceptance, and held-out/oracle leakage.

Learning experiments additionally compare no-learning, stable Memory-only,
complete Testament treatment, equal-extra-budget non-learning control, and
artifact-family ablations. They measure same-task retention,
same-distribution held-out performance, cross-domain transfer, negative
transfer, forgetting/update, unaffected-task non-inferiority, and full cost.
One successful demonstration cannot promote the harness or any artifact.

## 10. Conformance vectors

Tests MUST cover clone isolation; semantic ID reassignment; one-to-many
independent versus cooperative mapping; deterministic many-to-one order;
duplicate Delivery occurrences; cross-source reuse of one treatment Target;
missing Assets and references; malformed/duplicate recorded Actions; missing,
extra, and duplicate Action rules; fixture key/digest/action mismatch and
oracle fixtures; Action stripping, mocking, and explicit remap; all three
scheduler/config combinations; duplicate or unknown scripted transitions;
controller ID/digest mismatch; full-clone live-policy attempts; virtual timer
storms; controller escape attempts; crash at every step disposition; source
erasure; held-out leakage; partial finalization; non-portable snapshots; and
proof that a successful run creates no production mutation without a later
independent promotion transaction.
