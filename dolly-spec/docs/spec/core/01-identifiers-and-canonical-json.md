# Identifiers and Canonical JSON

Status: normative for Dolly Core v1.

This document defines the lexical forms, scopes, comparison rules, and canonical byte representation used by the Dolly Core specifications. The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described by RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

## 1. Scope and terminology

The rules in this document apply to persisted Core state, Extension RPC payloads, digests, replay fixtures, and management API representations. An implementation MAY use more efficient in-memory forms, but conversion to or from those forms MUST preserve the semantics and canonical bytes defined here.

“Runtime” means the trusted Dolly Runtime Worker for one Dolly instance. “Extension” and “Module” are untrusted with respect to Core identity fields.

## 2. Canonical JSON profile

Core JSON values MUST conform to the following profile:

1. The encoding MUST be UTF-8 without a byte-order mark.
2. An object MUST NOT contain duplicate member names.
3. Member names and string values MUST contain valid Unicode scalar values. Lone UTF-16 surrogates MUST be rejected.
4. The only permitted number form is a finite JSON number. `NaN`, positive or negative infinity, and negative zero MUST be rejected.
5. Integer-valued protocol fields MUST be JSON integers in the inclusive range `0..9007199254740991`, unless a field explicitly defines a string encoding.
6. Core schemas MUST reject unknown members. Extensibility is provided only through an explicitly declared namespaced `extensions` or `metadata` object.
7. A sender MUST NOT use JSON `null` to mean “not supplied” unless the field schema explicitly permits `null`. Otherwise, an absent optional field and a present `null` field are different values.
8. Canonical bytes MUST be produced with the JSON Canonicalization Scheme (JCS, RFC 8785).
9. A resolved configuration MUST materialize `max_json_nesting_depth`. Its v1
   normalization default and hard ceiling are both 64; policy MAY lower it to a
   positive integer. Semantic nesting depth is defined recursively: a primitive
   has depth zero, and an array or object has depth one plus the maximum depth of
   any child value, with an empty array or object having depth one. Object member
   names do not add depth. Consequently, a top-level container has depth one.

The semantic-depth limit is evaluated independently at every declared semantic
schema root. In particular, a `BlockEnvelope`, `ActivationManifest`,
`ModuleDescriptor`, and a schema-declared embedded `JsonValue` MUST each satisfy
the effective limit from its own root. When one already-validated semantic
document is embedded in another declared document, the embedded document is a
validated leaf for the enclosing document's structural semantic-depth check;
its own contents are not charged twice. Transport framing and JSON-RPC wrapper
objects have a separate wire parse-depth limit and MUST NOT consume this
semantic-value quota. Both limits still apply: resetting the semantic count does
not exempt the complete wire document from its transport parser limit.

Implementations MUST validate the profile before canonicalization. A value that cannot be represented by this profile MUST fail with `CORE_INVALID_JSON`; it MUST NOT be silently coerced.

### 2.1 Namespaced extension objects

Keys immediately below `extensions` or `metadata` MUST be reverse-DNS names owned by the producer, for example `org.dolly.channel`. A Core implementation:

- MUST preserve an unknown namespaced value byte-for-byte at the JSON value level when round-tripping it;
- MUST include it in the enclosing value's canonical digest;
- MUST NOT interpret it as a Core instruction; and
- MAY reject it for quota, depth, or security-policy reasons.

An untrusted Module MUST NOT write a namespace beginning with `org.dolly.core`.

A Module MAY write only its owning Extension's exact namespace and explicitly granted subordinate namespaces. It MUST NOT forge another Extension's metadata namespace. External client metadata MUST be nested below the trusted Channel Extension's namespace by that Channel; the client does not acquire the namespace merely by supplying its string.

### 2.2 Canonical digests

Unless another Core document explicitly says otherwise, a digest is:

```text
sha256:<64 lowercase hexadecimal digits>
```

It is computed over JCS bytes with the digest field itself omitted. Digest comparison MUST be constant-time when the comparison controls authority or accepts an Activation result.

The standard error is `CORE_DIGEST_MISMATCH`. Digest disagreement MUST NOT be repaired by accepting the sender's bytes under a newly computed digest.

## 3. Time representation

Persisted wall-clock timestamps MUST be UTC RFC 3339 strings in this exact form:

```text
YYYY-MM-DDTHH:MM:SS.ffffffZ
```

There are exactly six fractional-second digits. The date MUST be a real
proleptic-Gregorian calendar date and time; schema `format: date-time` is an
assertion in Dolly, not an annotation. Leap-second input (`:60`), impossible
month/day combinations, and offset or lowercase spellings MUST be rejected in
v1. Ordering of Blocks and Deliveries MUST NOT depend on wall-clock timestamps;
it is defined by sequence numbers in [Page, Delivery, and Subscription](03-page-delivery-subscription.md).

Deadlines and lease expiry MUST additionally be evaluated against an injectable
monotonic clock while the process is alive. The Runtime MUST persist the UTC
deadline, the wall-clock anchor, and the originally authorized duration. After
restart it reconstructs `remaining := deadline_utc - Clock.wall` and MUST clamp
that value into `0..original_authorized_duration` before anchoring it to the new
monotonic clock. Thus a backward wall-clock jump cannot grant more time than was
originally authorized and a forward jump cannot create a negative timer.

## 4. Identifier classes

All identifiers are case-sensitive. A Runtime MUST reject a non-canonical spelling rather than normalizing it.

### 4.1 Human-configured local identifiers

`InstanceId`, `PageId`, and `ModuleId` use this grammar:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

Their UTF-8 length MUST be between 1 and 63 bytes. Two consecutive hyphens, a trailing hyphen, uppercase ASCII, and non-ASCII characters are invalid. Display names are separate free-text fields and MUST NOT be used as keys or filesystem paths.

Scopes are:

| Type | Scope | Stable across restart | Runtime-assigned |
| --- | --- | ---: | ---: |
| `InstanceId` | one daemon installation | yes | no |
| `PageId` | one instance | yes | no |
| `ModuleId` | one instance | yes | no |

Changing a `PageId` or `ModuleId` is delete-and-create unless an explicit offline migration is performed. A display-name change MUST NOT change any identifier or storage path.

`REQ-ID-005` — Once a configured PageId or ModuleId has committed in an
instance, that ID is tombstoned after removal and MUST NOT identify an unrelated
new object. Re-creation under the same ID is legal only as an explicit offline
identity-adoption transaction that verifies compatible retained state,
backlog/reference disposition, and audit lineage. Ordinary delete followed by
create MUST use a fresh ID. This prevents old Blocks, consumer cursors, Memory
records, EMA state, and permissions from attaching to an unrelated replacement.

### 4.2 Extension identifiers and action names

`ExtensionId` is a reverse-DNS identifier with at least three dot-separated labels, for example `org.dolly.llm`:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$
```

It MUST be at most 255 UTF-8 bytes.

An `ActionName` contains an owned `ExtensionId` followed by one or more dot-separated operation labels, for example Extension `org.dolly.memory` owns `org.dolly.memory.search`. Every operation label follows the same label grammar as an Extension identifier. The complete name MUST be at most 255 bytes. Short unowned names such as `search_memory` are invalid in committed Blocks.

### 4.3 Runtime object identifiers

The daemon MUST assign one `DaemonInstallationId` when its durable installation metadata is first created. The Runtime MUST assign `BlockId`, `ActivationId`, `TraceId`, `ActionId`, `IngressId`, `RuntimeEventId`, `WorkerEpoch`, and one stable `ModuleStorageScopeId` for each logical Module. A Module MUST NOT supply these fields in a draft.

These identifiers are lowercase canonical UUIDv7 strings:

```text
xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
```

where `y` has RFC 9562 variant bits. The assigning daemon or Runtime authority MUST use a cryptographically secure random source for the random portion. The Runtime MUST prevent duplicate object UUIDs within an instance. A UUID collision is `CORE_ID_COLLISION` and MUST place the instance in fail-closed read-only mode until operator intervention.

`DaemonInstallationId` uses the same UUIDv7 lexical form, is persisted before any instance is created, and MUST never change or be reused for a different daemon installation. It scopes otherwise human-configured `InstanceId` values and MUST NOT be used as an authentication secret.

`LeaseToken` is 32 cryptographically random bytes encoded as canonical
unpadded base64url. A decoder MUST verify by decode/re-encode comparison; its
43rd character is one of `AEIMQUYcgkosw048`. It is a capability secret and
MUST NOT appear in ordinary logs.

A fresh `WorkerEpoch` identifies one Runtime Worker incarnation. It MUST be persisted before that Worker spawns an Extension and MUST never be reused. `ExtensionGeneration` is a positive safe JSON integer scoped to one configured Extension alias and incremented before every process spawn. Worker epoch, Extension generation, and per-Activation lease generation are independent fences.

`ModuleStorageScopeId` uses the UUIDv7 lexical form but is not a capability
secret. It is allocated before first Module instantiation, remains stable across
process restart, package generation, snapshot, and compatible migration, and is
never reused for another logical Module. A destructive reset receives a new
scope ID. The Host exposes it only on lifecycle/storage boundaries; it MUST NOT
enter an LLM Premise or ordinary Block merely to label state.

### 4.4 Sequence and revision numbers

The following are non-negative, safe JSON integers:

- `commit_seq`: instance-global ordering domain for committed Core records; every Delivery consumes one value from this domain;
- `page_seq`: ordering within one Page;
- `graph_revision`: immutable graph snapshot revision;
- `config_revision`: accepted instance configuration revision;
- `descriptor_revision`: one Module Descriptor revision;
- `lease_generation`: fencing generation for one Activation;
- `extension_generation`: fencing generation for one configured Extension process alias; and
- `attempt`: count of dispatch attempts for one Activation.

Zero is reserved as “not yet assigned” for `commit_seq` and `page_seq`; committed records MUST use values greater than zero. Revisions begin at one. `lease_generation` begins at one and increments before every dispatch. Sequence exhaustion is `CORE_SEQUENCE_EXHAUSTED`; the Runtime MUST stop admission before wraparound.

## 5. Composite identities

The following tuples, not their display serialization, define identity:

| Object | Identity tuple |
| --- | --- |
| Dolly instance | `(daemon_installation_id, instance_id)` |
| Subscription | `(instance_id, page_id, module_id)` |
| Delivery | `(instance_id, page_id, page_seq)` |
| Graph snapshot | `(instance_id, graph_revision)` |
| Module Descriptor | `(instance_id, module_id, descriptor_revision)` |
| Module private storage | `(daemon_installation_id, instance_id, module_storage_scope_id)` |

A `BlockId`, `ActivationId`, `TraceId`, `ActionId`, `IngressId`, or `RuntimeEventId` is only meaningful inside its Dolly instance. Core v1 MUST reject a direct cross-instance Block or Asset reference. A future network bridge MUST import content under new local identities.

## 6. Runtime-trusted identity boundary

The Runtime is the only authority for:

- Block and Action identifiers;
- the Block producer;
- creation time;
- `commit_seq` and `page_seq`;
- trace lineage and causal parents;
- graph and configuration revisions attached to an Activation;
- Module storage-scope identity and its directory/tenant mapping; and
- Worker epochs, Extension generations, and lease tokens and generations.

An Extension-supplied value in any trusted field is `CORE_FORGED_IDENTITY`. The Runtime MUST reject the enclosing draft or result, MUST record a security event, and MUST NOT copy the forged value into metadata as a fallback.

## 7. Standard Core error envelope

Core operations that fail return or persist this logical error shape:

```json
{
  "code": "CORE_INVALID_ID",
  "retryable": false,
  "outcome": "not_applied",
  "message": "Human-readable diagnostic",
  "details": {}
}
```

`code`, `retryable`, and `outcome` are normative. `retryable` is true only when
the same semantic operation MAY be retried under its original idempotency
identity and method policy. `outcome` is one of `not_applied`, `applied`, or
`unknown`. `message` is diagnostic and MUST NOT be parsed. `details` MUST be a
JSON object and MUST obey redaction policy. `correlation_id`, when present, is
a Runtime-assigned UUIDv7. Core protocols MAY map the envelope to a
transport-specific error, but MUST preserve these normative fields.

Error tables in the Core documents use phrases such as “conditionally” or “after operator action” only to describe policy. Every emitted envelope MUST still contain the concrete JSON boolean `retryable: true` or `retryable: false` chosen after evaluating that policy; a caller MUST NOT infer retryability from the error code alone.

| Code | Retryable | Meaning |
| --- | ---: | --- |
| `CORE_INVALID_JSON` | no | JSON violates the Core profile or schema |
| `CORE_INVALID_ID` | no | identifier has invalid form, scope, or canonical spelling |
| `CORE_FORGED_IDENTITY` | no | untrusted input attempted to set a Runtime-trusted field |
| `CORE_ID_COLLISION` | no | generated object identifier already exists |
| `CORE_DIGEST_MISMATCH` | no | declared digest does not match canonical bytes |
| `CORE_SEQUENCE_EXHAUSTED` | no | a required monotonic sequence cannot advance safely |
| `CORE_QUOTA_EXCEEDED` | policy-dependent | an explicit byte, item, nesting, or rate quota was exceeded |

## 8. Invariants

- **INV-ID-001 — Canonical equality.** Two Core JSON documents are semantically byte-identical for replay and digest purposes if and only if their JCS bytes are identical.
- **INV-ID-002 — Stable configured identity.** Display names and filesystem locations do not determine `InstanceId`, `PageId`, or `ModuleId`.
- **INV-ID-003 — Trusted provenance.** No untrusted process can choose or alter a committed Block's producer, creation sequence, trace lineage, or Runtime object identifiers.
- **INV-ID-004 — Monotonicity.** Committed sequence and revision numbers never decrease or repeat in their defined scope.
- **INV-ID-005 — Locality.** Direct Core references never cross a Dolly instance boundary.
- **INV-ID-006 — Digest reproducibility.** Every conforming implementation computes the same digest for the same accepted Core value.

## 9. Conformance cases

A conforming implementation MUST test at least:

- duplicate JSON keys;
- invalid UTF-8 and lone surrogates;
- `-0`, exponents, very large integers, and non-finite numbers;
- Unicode object-key ordering under JCS;
- semantic containers at the effective nesting-depth boundary and one level
  beyond it, plus the independent complete-wire depth boundary;
- uppercase UUIDs and non-v7 UUIDs;
- invalid local and reverse-DNS identifiers;
- sequence values at zero and at the maximum safe integer;
- digest verification before and after persistence; and
- rejection of trusted identity fields in Extension drafts.

The objects that use these identifiers are defined in [Block and Action](02-block-and-action.md). Their persistence and crash behavior are defined in [Storage and Recovery](06-storage-and-recovery.md).
