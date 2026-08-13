# Block and Action

Status: normative for Dolly Core v1.

This document defines the immutable information unit committed by the Runtime. Identifier, JSON, digest, and timestamp rules are inherited from [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md).

The RFC 2119/8174 requirement-keyword convention defined by that document applies here.

## 1. Model

A Module returns an untrusted `BlockDraft`. The Runtime validates and normalizes the draft, assigns every trusted field, and commits a `BlockEnvelope`. A committed `BlockEnvelope` is a value object: it has no update operation.

Delivery is not part of a Block. The fact that one Block arrived through one or more Pages is defined in [Page, Delivery, and Subscription](03-page-delivery-subscription.md).

### 1.1 BlockDraft

The logical v1 shape is:

```json
{
  "schema": "dolly.block-draft/v1",
  "description": "Optional diagnostic summary",
  "parts": [],
  "actions": [],
  "metadata": {},
  "hints": {
    "org.dolly.research.tensity": {
      "version": 1,
      "schema_uri": "urn:dolly:research-hint:tensity:1",
      "schema_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "experiment_id": "tensity-context-v1",
      "payload": {"score": 0.73}
    }
  }
}
```

Only `schema`, `parts`, and `actions` are REQUIRED. `description`, `metadata`, and `hints` are OPTIONAL. Before commit, an absent `description` becomes the empty string and absent `metadata` and `hints` become empty objects. A draft MUST NOT contain `id`, `action_id`, `producer`, `created_at`, `creation_commit_seq`, `trace`, `causal_parents`, Delivery occurrences, Page identifiers, or cursor data.

### 1.2 BlockEnvelope

After validation, the Runtime creates:

```json
{
  "schema": "dolly.block/v1",
  "id": "0198ab31-6c44-7e8a-b2bb-000000000001",
  "created_at": "2026-08-10T18:30:00.123456Z",
  "creation_commit_seq": 4812,
  "producer": {
    "kind": "module",
    "instance_id": "main",
    "module_id": "main-brain"
  },
  "trace": {
    "trace_id": "0198ab31-6c44-7e8a-b2bb-000000000002",
    "root_trace_ids": ["0198ab31-6c44-7e8a-b2bb-000000000002"],
    "causal_parents": [],
    "hop_count": 0
  },
  "body": {
    "description": "Optional diagnostic summary",
    "parts": [],
    "actions": [],
    "metadata": {},
    "hints": {}
  },
  "body_digest": "sha256:...",
  "envelope_digest": "sha256:..."
}
```

`body_digest` is the digest of the `body` value. `envelope_digest` is the digest of the complete envelope with `envelope_digest` omitted. The enclosing envelope is persisted in canonical form. The Runtime MUST derive `producer` from the authenticated ingress principal or executing Module; it MUST NOT copy a draft's assertion of source.

Producer `kind` is one of:

| Kind | `module_id` | Meaning |
| --- | --- | --- |
| `module` | REQUIRED | result of an Activation |
| `external` | prohibited | authenticated external ingress through a Channel or management API |
| `runtime` | prohibited | Runtime-generated diagnostic or control evidence |

An external application's own source identifiers belong in namespaced metadata and are untrusted data.

## 2. Parts

Every Part MUST be an object with an explicit `kind`. Bare strings and arrays containing a mixture of typed objects and bare strings are invalid.

### 2.1 TextPart

```json
{
  "kind": "text",
  "text": "hello",
  "format": "plain",
  "language": "en"
}
```

`format` is REQUIRED and is one of `plain` or `markdown`. `language` is OPTIONAL and, when present, MUST be a syntactically valid BCP 47 tag. Core does not interpret Markdown or trust embedded instructions.

### 2.2 JsonPart

```json
{
  "kind": "json",
  "value": {"answer": 42},
  "schema_uri": "urn:example:answer:v1"
}
```

`value` is REQUIRED and MUST satisfy the canonical JSON profile. `schema_uri` is OPTIONAL. Supplying a URI does not imply that the Runtime fetched or validated that schema unless an enclosing Extension contract separately requires it.

### 2.3 AssetPart

```json
{
  "kind": "asset",
  "asset_id": "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "media_type": "image/png",
  "view": {
    "kind": "image_rect_v1",
    "x0": 100000,
    "y0": 200000,
    "x1": 600000,
    "y1": 600000
  }
}
```

An `AssetId` is `ast_b3_` followed by the lowercase, unpadded base32 encoding
of a 256-bit BLAKE3 digest (52 characters using alphabet `a-z2-7`). The Asset
ID MUST be canonical: decoding and unpadded re-encoding reproduces the exact
string, so the final character is necessarily `a` or `q`. The Asset MUST
already have been imported into the same Dolly instance before Block commit.

Core v1 defines only a normalized fixed-point crop reference. Each coordinate
is an integer in `0..1000000`; `x0 < x1` and `y0 < y1`. The rectangle is
half-open on its right and bottom boundaries in upright display space. Exact
orientation, pixel rounding, and materialization are defined by the
[Asset Service](../services/assets.md); implementations MUST preserve these
four integers exactly.

`media_type` MUST be the lowercase, parameter-free canonical media type stored
as the Asset Service's `detected_media_type`. At Block validation the Runtime
MUST compare it with the authoritative Asset record and reject any mismatch;
declared upload metadata cannot relabel active content as a passive image. A
`view` is permitted only when that detected type is a supported raster image.

An absent `view` means the whole asset. A committed AssetPart creates a durable reachability edge from the Block to the Asset. Deleting a cache representation MUST NOT invalidate this reference.

### 2.4 BlockRefPart

```json
{
  "kind": "block_ref",
  "block_id": "0198ab31-6c44-7e8a-b2bb-000000000003",
  "relation": "evidence"
}
```

`relation` MUST be one of `forward`, `reply_to`, `evidence`, or `derived_from`. The referenced Block:

- MUST exist in the same Dolly instance;
- MUST already be committed;
- MUST have `creation_commit_seq` lower than the new Block's `creation_commit_seq`; and
- MUST NOT be the new Block itself.

These rules make the Block-reference graph a DAG. A committed BlockRefPart creates a durable reachability edge. Expansion is never implicit in Core delivery; a consumer MAY resolve the reference subject to explicit depth, byte, and token budgets.

## 3. Actions

An Action is declarative data carried by a Block. Core validates its common envelope but does not execute its business operation.

The draft form is:

```json
{
  "name": "org.dolly.memory.search",
  "arguments": {"query": "scheduler"},
  "target": {"module_id": "conversation-memory"},
  "correlation_id": "request-17",
  "idempotency_key": "activation:0198...:memory-search:1"
}
```

On Block creation the Runtime adds `action_id`. For a targeted Action it also
adds `contract_binding`, containing the target Module ID, the Descriptor
revision selected by the applicable graph snapshot, the complete selected
ActionContract, and `action_contract_digest =
sha256(JCS(contract_binding.action_contract))`. Those Runtime-added fields are
part of the immutable committed Block. The committed Action otherwise preserves
the draft's canonical value.
The Runtime MUST preserve `parts` and `actions` array order exactly. It assigns one Action ID to each Action in array order; it MUST NOT reorder Actions by name, target, or generated ID.

Rules:

1. `name` and `arguments` are REQUIRED.
2. `name` MUST be a namespaced `ActionName`. Its owner is the unique registered
   `ExtensionId E` in the applicable frozen graph for which `name` begins with
   `E + "."`; at least one operation label MUST follow. Graph validation rejects
   any pair of installed Extension IDs where one is a dot-label prefix of the
   other, so owner resolution cannot change by longest-prefix convention. Zero
   or multiple candidates is invalid.
3. `arguments` MUST be a JSON object.
4. `target`, `correlation_id`, and `idempotency_key` are OPTIONAL.
5. `correlation_id` and `idempotency_key`, when present, MUST be 1 to 128 printable ASCII characters.
6. A target Module MUST exist in the Activation's frozen `graph_revision` for Module output, or in the current graph revision for external ingress.
7. The target Module's configured Extension package MUST equal the owner prefix of `name`, and the target MUST subscribe to at least one Page in the Block's routed output set. Otherwise Block validation fails.
8. A target MUST NOT change Page routing. The Block is broadcast to every frozen output Page. A Module other than the target MUST treat the targeted Action as inert, although it MAY retain or display it as data.
9. An untargeted Action MAY be observed by multiple Modules and therefore does
   not promise single execution. It is always inert in stable v1. A later
   protocol version that adds broadcast execution MUST add an explicit,
   machine-bound contract rather than infer authority from Extension prose.
   Every built-in v1 action requires a target.
10. `idempotency_key` is untrusted application data. Its presence does not make Core responsible for an external side effect.

An operation needing exactly one logical consumer SHOULD set `target`. An operation with an external side effect MUST define idempotent handling or an explicit unknown-outcome recovery procedure; see [Activation and Module](04-activation-and-module.md).

### 3.1 Contract-binding validation

`REQ-BLOCK-001` — For every targeted Action, the applicable graph snapshot MUST
resolve the target Descriptor and exactly one ActionContract by `name`.
Descriptor admission has already rejected duplicate names. The Runtime MUST
copy that exact contract into `contract_binding`; verify that the binding's
Module ID, Descriptor revision, contract name, and digest equal the graph-pinned
selection; and validate `arguments` against the binding's frozen
`arguments_schema` in this order before committing the containing Block:

1. resolve the binding URI beneath the retained verified package without a
   network fetch;
2. reconstruct the closed transitive schema bundle and verify
   `schema_digest` over its UTF-8 JCS bytes;
3. resolve the URI fragment inside the verified root resource and perform full
   Draft 2020-12 validation; and
4. when `semantic_validator` is non-null, invoke exactly that installed
   ID/revision with the frozen Action and effective limits.

An unresolved resource or fragment, bundle-digest mismatch, missing validator,
validator-annotation mismatch, JSON Schema failure, or semantic-validator
failure rejects the entire Block. A semantic validator is a pure rejection
predicate; it MUST NOT repair arguments, execute the Action, consult mutable
current configuration, or grant a capability. The exact schema bundle and
validator revision remain reachable through the retained verified package for
every committed binding. Once the Block commits, its creation-time
`contract_binding` is the sole authority for argument interpretation,
consumption, result validation, idempotency classification, and side-effect
classification. A later graph, Descriptor, or ActionContract revision MUST NOT
reinterpret the Action. The Runtime MUST NOT also select a "current" contract
at Manifest creation or result commit.

### 3.2 Consumption and ActionResult

An Action is never a side-channel RPC. It reaches a Module only because the
containing committed Block is delivered through a configured Page and selected
into that Module's persisted Activation Manifest. The consumer processes
applicable Actions in manifest Delivery order, then in their array order. A
duplicate occurrence of the same Block in one manifest does not execute its
Action twice. The immutable Block, and therefore the Manifest input item,
carries the creation-time `contract_binding` unchanged. A generation that
cannot load the retained schema bundle or semantic-validator revision named by
a binding MUST NOT receive that Activation; a hot update MUST retain a
compatible generation until the input is consumed or use an explicit audited
input disposition. Cancelling and rebuilding the Manifest does not alter a
binding stored in its input Block. The Runtime MUST NOT substitute a newer
ActionContract.

The target Module MUST ledger a business operation by `action_id`. Re-observing
that ID returns the previously committed business result and MUST NOT repeat a
side effect. `idempotency_key`, when present, MAY additionally deduplicate a
logical operation across different Action IDs according to the owning
Extension's contract.

Business success, rejection, and unknown external outcome are semantic output,
not Activation transport failure. The Module returns zero or one normal
`BlockDraft`; when it reports one or more Action outcomes, it includes one JSON
Part per outcome whose `schema_uri` is
`https://dolly.example/spec/0.1/schemas/action-result.schema.json` and whose
`value` conforms to that schema. Results are ordered by the corresponding input
Actions. A successful Activation that consumes a targeted built-in Action MUST
include exactly one result for it. A transient failure that is safe to retry MAY
instead return `retryable_failure`, leaving the cursor unchanged. An unknown
external outcome MUST be committed as an `ActionResult` with status `unknown`;
it MUST NOT use `retryable_failure` to trigger an unsafe replay.

Multiple ActionResults share the single output BlockDraft; they are never
returned as multiple Block drafts or as out-of-band Extension RPC results. Core
validates the common ActionResult envelope when the schema URI above is used.
It then resolves `action_id` to exactly one applicable input Action and that
Action's creation-time `contract_binding`. For `status: succeeded`,
the Runtime MUST apply the same bundle-digest, fragment, JSON Schema, and exact
semantic-validator procedure to `result_schema`. The validator receives the
original frozen Action and the schema-valid `result`, so operation-specific
relations such as ordered delivery IDs or a requested byte range are checkable
without mutable lookup. For `failed` or `unknown`, the common schema requires
`result: null` and no successful-result validator runs. A missing action,
duplicate result, schema/bundle resolution failure, digest mismatch, unavailable
validator revision, or JSON/semantic result mismatch rejects the entire
BlockDraft. Validation does not authorize or execute the business operation and
does not reinterpret a valid business result.

## 4. Trace and causal fields

The Runtime derives every trace field. For a Module-produced Block, `causal_parents` is the sorted set of all distinct `block_id` values in the frozen Activation Manifest, including all fan-in Pages. The Module MUST NOT select a smaller parent set.

The Block-commit transaction MUST insert one durable causal-parent edge for
each entry in that set. Both endpoints MUST exist, and the parent's
`creation_commit_seq` MUST be lower than the child's. Garbage collection MUST
follow these child-to-parent edges transitively, so a rooted child keeps every
causal ancestor reachable even when no Delivery independently roots the
ancestor.

For an external or Runtime-produced Block with no input Blocks, `causal_parents` is empty and `hop_count` is zero. Otherwise, `hop_count` is one plus the maximum parent hop count. Trace joining and loop budgets are specified in [Routing, Trace, and Loops](05-routing-trace-and-loops.md).

## 5. Versioned research hints

`hints` is a stable opaque carrier for untrusted, Experimental data; it does
not stabilize the semantics of any carried hint. Each key MUST be a qualified
name and each value MUST bind `version`, immutable `schema_uri` plus
`schema_digest`, `experiment_id`, and an arbitrary canonical-JSON `payload`.
Core validates and preserves that envelope but MUST NOT fetch the schema,
interpret the payload, assign a default, convert between versions, or infer a
scale. Unknown or unsupported hints are retained as data and ignored by
semantic consumers.

A producer or consumer MAY use a hint only when an enabled
[`research-hint-registration`](../../../schemas/research-hint-registration.schema.json)
entry matches the exact qualified name, version, schema URI, schema digest,
experiment ID and plan digest, producer/consumer Module, and graph/config
revision. This registry entry is an Experimental capability, not an Extension
RPC capability or ambient authority. A mismatch, invalid payload, missing
registry entry, expired entry, or disabled experiment MUST select the stable
behavior as if the hint were absent.

In particular, Core v1 does not define a `tensity` field, range, neutral value,
producer, calibration, or consumer. A versioned `tensity` experiment MAY use
the opaque carrier only under the separate research specification. No hint or
research registry entry may:

- delete or retain a Block, Delivery, Asset, Action, configuration, or tool result;
- advance a cursor;
- change retry semantics; or
- bypass a quota or loop limit.

The complete hint envelope contributes to canonical Block identity. Hint keys,
versions, payloads, and registry decisions MUST be observable in the research
trace subject to normal redaction policy.

## 6. Validation limits

The table values are the v1 normalized defaults. Configuration MAY lower every
value. Only canonical committed `BlockEnvelope` bytes may be raised, with an explicit policy,
up to the 8,388,608-byte v1 hard ceiling. The Runtime MUST predict the canonical
envelope size, including trusted fields, and reject an oversized draft before
assigning identities. The structural counts, TextPart bytes,
metadata bytes/properties, research hint entries, canonical semantic nesting depth, causal parents,
and root trace counts shown below are
also the v1 schema hard ceilings and cannot be raised without a schema/spec
revision. All effective values are explicit in the resolved configuration.

| Limit | Default |
| --- | ---: |
| canonical committed `BlockEnvelope` bytes (`max_block_bytes`) | 1,048,576 |
| Parts per Block | 256 |
| Actions per Block | 64 |
| UTF-8 bytes in one TextPart | 262,144 |
| canonical metadata bytes | 65,536 |
| namespaced metadata properties | 32 |
| namespaced research hint entries | 8 |
| canonical `BlockEnvelope` semantic nesting depth (`max_json_nesting_depth`) | 64 |
| causal parents | 256 |
| root trace identifiers | 16 |

The Runtime MUST predict semantic depth on the committed `BlockEnvelope`, not
only on the shallower draft. Depth is counted from the Block root by the
algorithm in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md);
JSON-RPC transport wrappers do not consume this semantic quota. Validation MUST
complete before identity assignment. If validation fails, no Block, Action,
Delivery, or sequence number is committed.

## 7. Immutability and corrections

There is no `update_block`, `patch_block`, or mutable occurrence counter. A correction or retraction MUST be a new Block that references the earlier Block with an appropriate Part and application-level semantics. Storage compaction MAY change physical encoding but MUST preserve canonical envelope bytes and digest.

## 8. Errors

| Code | Retryable | Meaning |
| --- | ---: | --- |
| `BLOCK_INVALID_DRAFT` | no | draft fails its schema or contains a trusted field |
| `BLOCK_TOO_LARGE` | no | a fixed Block limit is exceeded |
| `BLOCK_REF_NOT_FOUND` | conditionally | referenced Block is not committed locally |
| `BLOCK_REF_NOT_PRIOR` | no | reference would be self-, forward-, or cyclic |
| `ASSET_REF_NOT_FOUND` | conditionally | referenced local Asset is unavailable or uncommitted |
| `ASSET_VIEW_INVALID` | no | crop fixed-point coordinates are invalid |
| `ACTION_TARGET_NOT_FOUND` | no | target does not exist in the applicable graph revision |
| `ACTION_INVALID_NAME` | no | action name is not a valid owned namespace |
| `ACTION_OWNER_AMBIGUOUS` | no | applicable graph does not yield exactly one registered owner prefix |

“Conditionally” means retryable only when the operation races a separately authorized import that has not yet committed. Core MUST return an explicit retry decision; a caller MUST NOT infer it from the code alone.

## 9. Invariants

- **INV-BLOCK-001 — Immutability.** Canonical bytes of a committed Block never change.
- **INV-BLOCK-002 — Runtime identity.** Every trusted envelope, producer, trace, causal, sequence, Block ID, and Action ID field is Runtime-assigned.
- **INV-BLOCK-003 — Delivery separation.** Page, cursor, occurrence, and repeat-count data never appears in a Block body or determines Block identity.
- **INV-BLOCK-004 — Acyclic references.** A Block references only locally committed, strictly earlier Blocks.
- **INV-BLOCK-005 — Fan-in provenance.** A Module output names every distinct input Block in its frozen manifest as a causal parent.
- **INV-BLOCK-006 — Routing independence.** Action targets and contents never change the frozen Page output set.
- **INV-BLOCK-007 — Hint non-authority.** An opaque research hint or its registry entry cannot change Core correctness, durability, authorization, side-effect, or retention semantics; unsupported hints select the stable behavior.
- **INV-BLOCK-008 — Creation-time Action authority.** A targeted Action is interpreted and its result is validated only by the complete contract binding committed with that Action; later graph or Descriptor revisions cannot reinterpret it.

## 10. Crash expectation

Draft validation and identity assignment occur inside the commit procedure defined by [Storage and Recovery](06-storage-and-recovery.md). A crash before the SQLite commit MUST leave no visible Block. A crash after that commit MUST reveal the complete immutable Block and all durable output Deliveries, or none of them; partial durable fan-out is forbidden.
