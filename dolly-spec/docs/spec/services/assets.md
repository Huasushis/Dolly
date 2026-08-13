# Asset Service Specification

Status: **normative for Dolly v1**, except sections explicitly marked Experimental.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

## 1. Scope and authority

The Asset Service imports, identifies, validates, stores, leases, materializes, and eventually deletes binary objects. JSON carries asset descriptions; asset bytes MUST travel through a bounded host stream rather than repeated base64 copies between Extensions.

The Core is the only authority that may turn an `asset_input` draft into an immutable `AssetRef`. An Extension MUST NOT mint an `AssetId`, claim that an import is available, mutate stored bytes, or delete an asset directly.

An available asset is immutable. Editing, transcoding, redaction, or cropping MUST produce either an `AssetView` or a new derived asset with provenance; it MUST NOT change the source asset.

## 2. Identifiers and records

An import request receives an opaque UUIDv7 `ImportId`. After all bytes have been read, the service MUST compute:

```json
{
  "algorithm": "blake3-256",
  "digest": "<64 lowercase hexadecimal characters>"
}
```

`AssetId` MUST be `ast_b3_` followed by the lower-case, unpadded base32 encoding
of the same 256-bit digest. A decoder MUST reject non-canonical encodings by
decode/re-encode comparison; for a 256-bit value the 52nd character is `a` or
`q`. The digest is over the exact decoded byte sequence accepted from the
source, before metadata removal, EXIF orientation, or transcoding. Identical
accepted bytes within one security domain MUST resolve to the same `AssetId`.

The durable asset record MUST contain at least:

```json
{
  "asset_id": "ast_b3_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "content_hash": {"algorithm": "blake3-256", "digest": "0000000000000000000000000000000000000000000000000000000000000000"},
  "byte_length": 1234,
  "declared_media_type": "image/png",
  "detected_media_type": "image/png",
  "created_at": "2026-08-09T15:00:00.000000Z",
  "security_domain": "personal",
  "orientation": 1,
  "encoded_width": 1920,
  "encoded_height": 1080,
  "display_width": 1920,
  "display_height": 1080,
  "local_state": "present",
  "replica_state": "disabled"
}
```

Dimension and orientation fields MAY be absent for non-images. A hash match across different security domains MUST NOT by itself grant cross-domain read access.

## 3. Accepted import sources

An `asset_input` draft MUST use exactly one of:

- `existing_asset`: an already-visible `AssetId`;
- `inline_base64`: base64 with a declared media type and an encoded-size limit;
- `module_file`: a Host-issued file capability, not an arbitrary path string;
- `remote_url`: an HTTPS URL fetched by the Host under the policy below;
- `stream`: a single-use Host stream capability with a declared maximum length.

Unknown source kinds MUST be rejected. Base64 decoding MUST be strict. The service MUST enforce configured encoded and decoded byte limits while streaming, not after buffering the entire object.

Every `remote_url` source MUST carry a positive `max_bytes` bound for that
specific import. The effective bound is the minimum of this value, remaining
caller-operation budget, capability scope, and Asset Service limit. A model-
output URL is a sealed source descriptor, not response content, and its import
uses the persisted model request/ordinal Import ID and finite output lease
defined by the Model Gateway.

`inline_base64` additionally obeys `max_inline_base64_chars`, whose v1 hard
ceiling is 50,331,648 characters and whose resolved value plus 65,536 bytes of
envelope reserve MUST fit the Extension protocol frame limit. `remote_required`
is an explicit boolean on every import request; it has effect only when an
object-store replica is configured, and requesting it without one fails before
acquisition.

## 4. Import state machine

The durable `ImportRecord.state` is one of:

```text
ACCEPTED -> ACQUIRING -> VERIFYING -> COMMITTING -> AVAILABLE
    |           |           |            +--> REPLICATING -> AVAILABLE
    |           |           |                         |
    |           |           |                         +--> REPLICA_FAILED
    |           |           |                                  |
    |           |           |                                  +--> REPLICATING
    +-----------+-----------+--------------------------------------> REJECTED
    +--------------------------------------------------------------> CANCELLED
```

The allowed forward and crash-recovery transitions are exactly:

```text
ACCEPTED       -> ACQUIRING | REJECTED | CANCELLED
ACQUIRING      -> ACCEPTED | VERIFYING | REJECTED | CANCELLED
VERIFYING      -> ACCEPTED | COMMITTING | REJECTED | CANCELLED
COMMITTING     -> ACCEPTED | AVAILABLE | REPLICATING | REJECTED | CANCELLED
REPLICATING    -> AVAILABLE | REPLICA_FAILED | CANCELLED
REPLICA_FAILED -> REPLICATING | REJECTED | CANCELLED
```

The following transition semantics are mandatory:

1. `ACCEPTED`: the request, caller, limits, and source descriptor are durable; no bytes are trusted.
2. `ACQUIRING`: bytes are read into a private staging object while byte count and hash are updated. A remote redirect is a new network target and MUST be revalidated.
3. `VERIFYING`: acquisition is complete. The service validates length, detected media type, decoder safety, image metadata, and policy. No more source bytes may be read.
4. `COMMITTING`: the verified staging object is durable. The service moves or links it into the content-addressed local store, then commits the asset row and import-to-asset mapping. A non-`remote_required` import may proceed directly to `AVAILABLE`; a `remote_required` import MUST proceed to `REPLICATING`.
5. `REPLICATING`: the local object and row are durable but MUST NOT be exposed through this import. The service uploads or verifies the configured object-store object using the same content hash.
6. `REPLICA_FAILED`: the required replica is not verified. This state is non-available and records the last bounded error, retry time, and attempt count. A retry uses compare-and-set to return to `REPLICATING`; a terminal policy decision may move the import to `REJECTED`.
7. `AVAILABLE`: the asset row and local bytes both exist and hash-verify. For a `remote_required` import, the recorded replica MUST also exist and hash-verify. Only this state may produce an `AssetRef`.
8. `REJECTED`: a terminal policy or validation failure with a stable error code. Staging bytes MUST be scheduled for deletion; deduplicated bytes already referenced by another import or committed object MUST NOT be deleted.
9. `CANCELLED`: caller cancellation before `AVAILABLE`. Cancellation after availability affects only the import request, not the deduplicated asset.

Forward transitions MUST be compare-and-set on the current state. Repeating the same `ImportId` with byte-for-byte identical parameters MUST return the existing state. Reusing it with different parameters MUST return `IMPORT_ID_CONFLICT`.

After a crash, `ACQUIRING` and `VERIFYING` MUST restart from `ACCEPTED` unless a complete staging object with the recorded length and hash is durable. `COMMITTING` MUST be resolved by checking the content-addressed object and database mapping: complete the mapping if the object verifies, otherwise return to `ACCEPTED`. A recovered `remote_required` import with a verified local mapping MUST enter `REPLICATING`, never `AVAILABLE`, until the remote object verifies. Recovery of `REPLICATING` or `REPLICA_FAILED` MUST compare the recorded object key, content hash, and remote object: a verified match advances to `AVAILABLE`; absence or mismatch remains non-available and follows the bounded retry policy. Orphan staging and content-addressed files MUST be reclaimed by a scrubber after a grace period.

The service MUST NOT expose an asset whose bytes are missing, whose length differs, or whose digest fails verification.

## 5. Media validation and orientation

Declared media type is a hint. The service MUST independently sniff the media type from bounded content. A material mismatch MUST be rejected unless a configured, audited compatibility rule permits it. Active content such as SVG, HTML, PDF, and office formats MUST retain its real type and MUST NOT be relabeled as a passive image.

For raster images, EXIF orientation MUST be parsed as an integer from 1 through 8. Missing orientation means `1`. Invalid orientation MUST be rejected or normalized to `1` only when the decoder proves there is no orientation transform; the decision MUST be recorded.

The service MUST preserve original bytes. All image coordinates are defined in **upright display space after applying the EXIF orientation transform**. `display_width` and `display_height` therefore swap for orientations 5 through 8. Provider-specific coordinate conventions MUST be introduced only by a Model Gateway adapter and MUST NOT alter the stored `AssetView`.

## 6. Normalized crop semantics

An image crop MUST use fixed-point integers, never binary floating point:

```json
{
  "kind": "image_rect_v1",
  "x0": 100000,
  "y0": 200000,
  "x1": 800000,
  "y1": 900000
}
```

Each coordinate MUST be in the inclusive range `0..1_000_000`; `x0 < x1` and `y0 < y1`. The origin is the top-left of upright display space. Right and bottom edges are exclusive.

For display dimensions `W` and `H`, materialization MUST compute:

```text
left   = floor(x0 * W / 1_000_000)
top    = floor(y0 * H / 1_000_000)
right  = ceil (x1 * W / 1_000_000)
bottom = ceil (y1 * H / 1_000_000)
```

The results MUST be clamped to `[0,W]` and `[0,H]`. Integer multiplication MUST use a width that cannot overflow for the maximum supported dimension. A crop that becomes empty after decoder bounds checks MUST fail with `EMPTY_CROP`.

An `AssetView` is the tuple `(source_asset_id, orientation=v1-upright, rect, optional deterministic transform profile)`. Creating a view MUST NOT copy bytes. A derived byte object materialized from a view MUST have its own `AssetId` and MUST record the source asset, exact view, codec, encoder version, and encoder parameters.

## 7. References, leases, pins, and garbage collection

The service recognizes three independent retention mechanisms:

- a durable reference owned by a committed Block, retained Page delivery, Memory record, or derived asset;
- a durable pin owned by an authorized component and carrying a reason, creation time, and optional expiry;
- a temporary lease carrying an unguessable `LeaseId`, owner, purpose, and expiry.

Creating or renewing a lease MUST be atomic with checking that the asset is not tombstoned. A lease MUST have a finite expiry and MUST NOT be silently converted to a pin. Pins without an expiry require an explicit privileged capability.

When the Model Gateway imports Provider output, it MUST create a finite lease
owned by the authenticated model operation before exposing the Asset Part.
That lease remains live while the successful response can be consumed. A Core
commit that accepts the Part creates the durable Block reference atomically;
the Gateway or Host then releases the temporary lease after the Activation
disposition is known. Abort, cancellation, deadline, or lease expiry never
creates a durable reference. Recovery MUST reconcile the original Import ID
and lease instead of minting another import merely to defeat GC.

An asset becomes a GC candidate only when all durable-reference counts are zero, no live pin exists, no unexpired lease exists, and the configured grace period has elapsed. GC MUST use a mark/tombstone/sweep protocol:

1. atomically mark the asset `TOMBSTONED` with a deletion generation;
2. reject new leases and references for that generation;
3. recheck references, pins, and leases in the deletion transaction;
4. delete replicas and local bytes according to Section 8;
5. retain an audit tombstone containing only identity, timestamps, sizes, and deletion outcome.

If a new durable reference wins the transaction before tombstoning, GC MUST abort. A tombstoned asset MUST NOT be resurrected by reusing its old database row; reimporting the same bytes MAY create a new live generation with the same content-derived `AssetId` and a new lifecycle record.

## 8. Object-storage replicas and failure semantics

Local content-addressed storage is authoritative in v1. Object storage is an optional replica with state `disabled | pending_upload | present | upload_failed | pending_delete | delete_failed | deleted`.

An upload failure MUST NOT make a locally available asset unavailable unless the caller explicitly requested `remote_required` before commit. An optional replica uses `pending_upload` or `upload_failed` while the import may remain `AVAILABLE`. A `remote_required` import instead uses `REPLICATING` or `REPLICA_FAILED`, MUST remain non-available until both stores verify, and MUST return `REMOTE_REPLICA_FAILED` for the failed attempt rather than silently falling back. Automatic retries MUST use bounded backoff; exhausting the automatic retry budget leaves the durable import in `REPLICA_FAILED` for explicit retry, configuration repair, cancellation, or terminal rejection.

The resolved Asset configuration MUST materialize `max_import_attempts`,
`retry_base_ms`, and `retry_cap_ms` under `replica_retry`; the v1 defaults are
5, 1,000 ms, and 60,000 ms. Import retry delay uses the same persisted
full-jitter inclusive-integer algorithm as
[Core Activation retry](../core/04-activation-and-module.md), with the
attempt ordinal local to the import and the cap applied before exponentiation.
`retry_base_ms` MUST NOT exceed `retry_cap_ms`. An explicit retry after
exhaustion starts a new audited retry series on the same `ImportId`; it does not
reacquire source bytes when the verified local object is still present.

The service MUST use a dedicated configured bucket/prefix and MUST delete only objects it uploaded and recorded. It MUST NOT delete the source of a `remote_url`. Signed URLs MUST be short-lived, scoped to one object and method, and treated as secrets in telemetry. A signed or otherwise credential-bearing source descriptor retained for crash recovery MUST be encrypted or delegated to an operating-system secret store at rest, MUST never appear in ordinary status/errors, and MUST be erased after its terminal recovery-retention window.

If remote deletion fails, the lifecycle MUST remain `TOMBSTONED` with replica
state `delete_failed`; the service MUST retry using the configured replica
backoff, continuing at `retry_cap_ms` after the exponential cap until deletion
succeeds or an authenticated operator records an explicit external-orphan
disposition. It MUST NOT report `PURGED` while the object may remain. Local
deletion MAY proceed after the tombstone is durable. Operators MUST be able to
enumerate deletion failures. An OSS ETag MUST NOT be used as the Dolly content
hash.

## 9. Security requirements

Remote imports MUST allow HTTPS by default, reject embedded credentials, validate every resolved IP and redirect against an SSRF deny policy, defend against DNS rebinding, bound redirects, response bytes, decompressed bytes, duration, and idle time, and reject unsupported schemes. Private, loopback, link-local, multicast, metadata-service, and configured internal ranges MUST be denied unless an explicit capability allows the exact destination.

File imports MUST use a Host-issued capability rooted in an allowed directory. The Host MUST resolve symlinks and canonical paths and MUST prevent traversal and time-of-check/time-of-use replacement. Extensions MUST never receive raw authority to the asset-store directory.

Decoders MUST run with resource limits. Archive recursion, pixel count, frame count, sample duration, decompression ratio, and parser depth MUST be bounded. Malware or content-policy scanning MAY quarantine an import; quarantined bytes MUST NOT become `AVAILABLE`.

Read, stream, view, pin, and delete operations MUST authorize the caller's security domain. Logs MUST NOT contain asset bytes, base64, signed URLs, or local paths unless an explicit payload-debug mode is enabled with redaction and retention controls.

## 10. Errors and observability

Failures MUST use exactly the common error envelope. Asset-specific `phase`,
`import_id`, and optional `asset_id` MUST be fields inside `details`; they MUST
NOT be extra top-level fields. Stable codes include `SOURCE_DENIED`, `SOURCE_UNAVAILABLE`,
`SIZE_LIMIT`, `INVALID_BASE64`, `MEDIA_TYPE_MISMATCH`, `UNSAFE_MEDIA`,
`HASH_MISMATCH`, `INVALID_ORIENTATION`, `INVALID_CROP`, `EMPTY_CROP`,
`STORAGE_FULL`, `REMOTE_REPLICA_FAILED`, and `IMPORT_ID_CONFLICT`.

Metrics SHOULD cover imported and rejected bytes, state duration, deduplication, active leases and pins, GC candidates, tombstones, local verification failures, and replica failures. Metric labels MUST NOT contain URLs, paths, asset IDs, or user content.

## 11. Conformance tests

An implementation MUST test:

- every legal and illegal state transition, crash recovery at each transition, and conflicting reuse of `ImportId`;
- exact byte hashing, deduplication, missing-object repair, and hash mismatch quarantine;
- MIME spoofing, strict base64, redirect SSRF, DNS rebinding, symlink races, decompression bombs, and bounded streams;
- bounded `remote_url` acquisition, sealed signed-URL recovery, URL expiry, and
  proof that neither status nor diagnostics disclose the source;
- all eight EXIF orientations and crop edge values `0`, `1`, `999999`, and `1000000` with golden pixel results;
- lease expiry, renewal racing with GC, pin expiry, reference creation racing with tombstone, and idempotent repeated sweep;
- model-output lease handoff to an atomic Block reference, Activation abort,
  and restart under the original Import ID;
- optional and `remote_required` OSS upload failure, restart during every replica state, proof that a required unverified replica is never exposed, delete failure, and proof that external URL sources are never deleted;
- authorization isolation between two security domains that contain identical bytes.

`REQ-ASSET-001` — Asset identity, upright crop rounding, availability, leases,
and GC outcomes MUST follow this document exactly and remain crash-testable.
