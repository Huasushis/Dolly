# Media Storage and Access Specification

Status: Draft

This document proposes the normative contract for storing Media, referring to
Media from a Block, and granting temporary access to a model provider. It
replaces the earlier multi-object design with one Core-managed Media identifier
inside each Dolly instance.

The requirement words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY have the
meanings defined by Request for Comments 2119. Because this document is a Draft,
they describe a proposed contract and do not claim complete implementation.

## 1. Decision and scope

The contract has four central rules:

1. One Media item has one Core-managed identifier, `mediaId`, scoped to one
   Dolly instance.
2. A crop is part of a reference or access request, not another object.
3. Storage location and deletion state are internal records, not public Media
   identities.
4. Access by a remote provider is temporary, recipient-specific, and does not
   expose storage credentials.

This document covers registration, Block references, crop conversion, local
and remote storage, lifetime, provider access, deletion, durability, migration,
and required tests. Model message formats and user-interface layout are outside
its scope.

## 2. Terms

An **identifier (ID)** is an opaque string that names one record or operation;
fields such as `mediaId` and `registrationId` are identifiers, not paths. A
configuration field ending in `Ms` expresses a duration in milliseconds.

### 2.1 Media

**Media** is one immutable original byte sequence together with metadata
obtained by inspecting those bytes. Its only Core-managed identifier is
`mediaId`, scoped to one Dolly instance. Blocks refer to that identifier through
a `media-reference` content item.

The name Media is used instead of file because the bytes may come from an
upload, a provider response, or another authorized stream and need not have a
filesystem path. It also distinguishes the immutable content from the changing
records that say where its bytes are stored.

Inspected metadata includes a Multipurpose Internet Mail Extensions (MIME)
media type and, when applicable, image dimensions, duration, frame count, or
channel count. A caller-declared MIME media type is only a hint.

### 2.2 Media reference crop

A **Media reference crop** is the optional normalized rectangle named `crop` in
a Block's `media-reference` item. It selects a region of the original image for
one use. The ordinary term crop is sufficient for the action; the longer phrase
is used only when distinguishing Block content from provider-specific pixels.

### 2.3 Media storage record

A **Media storage record** is an internal record saying that one storage
adapter holds the original bytes for one Media item. It contains the Media
identity, adapter identity, opaque object locator, object version when present,
storage `visibility`, and upload or deletion state. The `visibility` value is
`private` or `public`; it describes storage exposure and is not a provider
access mode.

This record is separate because a Media item can remain unchanged while its
storage location or deletion state changes. It is not another Media item and is
never placed in Block content.

### 2.4 Provider access grant

A **provider access grant** is the provider-facing result for one trusted
request to read one Media item. The source value `MediaAccessGrant` contains
the recipient, `mediaId`, and optional crop, plus exactly one of these forms:

- a private signed uniform resource locator (URL), its expiry, and an access
  lease identifier;
- an explicitly enabled public URL and an access lease identifier; or
- an inline Base64 copy of the bytes, with no access lease identifier.

The word grant is necessary because this value is scoped to a recipient and
request; it is not a stable Media location. A signed URL expiry limits new
requests but does not prove that a provider did not start a fetch earlier. A
provider access grant never changes Media identity and never contains an
object-storage access key.

### 2.5 Storage adapter

A **storage adapter** implements storage operations for one configured service
or local store. It declares whether it can sign reads, return public URLs, and
encode the exact crop defined here. Dolly selects behavior from those declared
features, not from a provider name.

The adapter descriptor's `durability` is either `volatile` or `persistent`.
A persistent adapter survives restart and therefore must implement locator
planning, conditional creation, metadata reconciliation, bounded input/output
(I/O), and exact deletion. A volatile adapter provides none of those restart
claims and may be used only with a volatile `MediaStore`.

### 2.6 Media durability

**Media durability** says whether the complete Media state survives a process
restart. It is stored as `durability` because persistence is not a storage
adapter feature: metadata, reference-graph state, and original bytes must make the
same promise.

The only values are:

- `volatile`: Media state is process-local and the byte store is volatile;
- `persistent`: metadata, reference-graph state, and original bytes persist together.

A persistent Media store requires a persistent byte store and a synchronous
metadata persistence observer. A volatile Media store requires a volatile byte
store. A mismatch fails during construction.

### 2.7 Storage namespace

A **storage namespace** is the non-secret, canonical configuration that
identifies the exact provider, endpoint, account, container, object prefix, and
addressing mode used by a persistent storage adapter. It is persisted because
an adapter ID or credential does not prove that recovery still addresses the
same object location. Dolly compares the namespace before external I/O and
fails closed on a mismatch.

### 2.8 Media ingress capability

A **Media ingress capability** is temporary permission to perform one Media
ingress mode for one subject and one registration ID, within byte and expiry
limits. The implementation represents that permission with an opaque handle;
it is required because a path, URL, byte field, or provenance label is data
rather than permission to read or register bytes.

### 2.9 Media store

A **Media store** is the trusted runtime component that registers Media,
persists storage and provider-access records, and coordinates their recovery.
The implementation identifier `MediaStore` names that component in source code;
it is not a second Media identity or an Extension capability.

## 3. Media record

The immutable record uses `dolly.media/2`. It contains `mediaId`, digest, byte
length, inspected MIME media type, optional declared type, inspected dimensions
or timing metadata, provenance, and creation time.

The runtime assigns `mediaId`. The digest is integrity metadata, not a public
identity and not permission to deduplicate across users or security boundaries.
Replacing bytes creates a new Media item.

Registration MUST read through an authorized source with finite limits,
calculate the digest, inspect with a bounded decoder, and reject dangerous type
mismatches or unsupported formats.

A **Media registration request**, represented by `MediaRegistrationRequest`,
is the trusted-host request object containing `registrationId`, bytes, an
optional declared MIME media type, and provenance. It deliberately contains no
caller-selected strong-reference owner.

A **Media registration record** is the persistent identity and progress record
created for that request. It binds `registrationId` to one immutable input and
one runtime-assigned `mediaId` so a retry after process exit cannot allocate
another Media item. This record is required because portable byte storage and
the Core state snapshot do not share one atomic transaction. Its schema is
`dolly.media-registration/4`, and its state is `pending`, `available`,
`deleting`, or `deleted`.

An active registration records whether it holds the registration strong
reference in `holdsRegistrationReference`. A deleted registration always sets
that field to `false` and retains only the input identity fields through
`retainUntil`; expiry removes this compact record and permits reuse of the
registration ID.

Provenance records how authorized bytes entered the store; for example,
`local-file` means an approved local-file reader supplied them,
`remote-fetch` means an approved remote fetch supplied them, and `derived`
means a trusted-host Media derivation produced them from another Media item.
Provenance is diagnostic data and never substitutes for a Media ingress
capability.

At an untrusted ingress boundary, a Media ingress capability binds one subject,
one ingress mode, and one registration ID before file, network, or byte-stream
I/O starts. The caller's registration ID is an idempotency value within that
subject, not a global record identity. The trusted ingress service derives the
internal registration ID from the subject and caller value before calling
`MediaStore`. Two subjects using the same caller value therefore cannot read,
conflict with, or release each other's registration.

With persistent durability, the runtime MUST persist the `pending` registration
before writing bytes. After the stored bytes pass digest validation, the runtime
registers the Media resource, adds the registration record's
`media-registration` strong reference, and persists the `available` state
before exposing the Media item. A failed registration MUST NOT expose partial
Media. Retry with the same `registrationId` and input returns the same
`mediaId`; reuse with different input is a conflict.

Startup recovery completes a `pending` registration when matching bytes are
already present. When bytes are absent, it preserves the visible `pending`
record so a retry with the same input can finish it; it does not allocate a new
`mediaId` or silently discard the record.

The available registration record initially holds the Media item through its
registration strong reference and records that fact with
`holdsRegistrationReference: true`. Its strong reference may be
released only after the runtime proves another persistent strong-reference path
still reaches that Media item; otherwise release fails and restores both the
reference and the field. `MediaStore.registerMedia` accepts exactly one
`MediaRegistrationRequest` and is an internal interface for trusted host
subsystems. It MUST NOT be exposed directly as an untrusted Extension
capability.

## 4. Block references

The only Media reference understood by Core is the `media-reference` item in
the ordered Block content schema. It contains `type`, `mediaId`, and optionally
`crop`, caption, and accessibility data.

JavaScript Object Notation (JSON) fields elsewhere in a payload, plain text,
filenames, and URLs MUST NOT create a Media reference. Core derives
reference-graph dependency edges only from validated `media-reference` items.

Block commit MUST fail atomically when `mediaId` is missing, when a crop is used
with non-image Media, or when the crop cannot select at least one pixel.
Repeated references to the same Media in one Block do not create new identities
or caller-managed reference counts.

`mediaId` is shared by trusted Core subsystems inside one Dolly instance. This
is necessary because a Block can carry a Media reference through several Pages
and Modules without changing the Media identifier. The trusted Core Media
reference resolver, represented by the source interface
`MediaReferenceResolver`, verifies existence and crop validity during Block
commit. It is an internal validation interface, not permission for an Extension
to read bytes, request a URL, or probe arbitrary Media identifiers.

An untrusted Extension may access Media only through an opaque capability that
the host derives from validated `media-reference` items in immutable Blocks
already delivered to that Extension's authenticated Module job. The capability
scope includes the Dolly instance, Extension session, Module, delivered Block,
Media identifier, permitted operation, byte limit, and crop boundary. A request
MUST NOT broaden a delivered crop. A raw `mediaId` from configuration, model
output, guessed text, another session, or an unverified result is data rather
than authorization. Returning such an identifier in a Block proposal likewise
does not authorize the proposed reference; the host must prove that it came
from the Module job's delivered references or another explicit host grant.

Before an Extension Media read capability is available, Core already applies a
separate result validation rule to a Module result submitted with a Delivery
Claim. Its `source` must name the Claim's consumer Module, and every output
`media-reference` must reuse a Media reference in that Claim's input Blocks.
An uncropped input permits the full Media or a valid crop. When every input
reference for that Media has a crop, the output crop must fit inside one
delivered crop; Core rejects a full-image output, a larger crop, and a region
assembled from multiple crops. Core performs this check before it persists a
`prepared` Module result commit record and repeats it before recovery resumes
such a record. A newly registered Media item or a different grant issued by
trusted Core does not satisfy this result rule.

This result validation is not a Media read operation and does not turn a Block
reference into Extension authority. A trusted Core direct Block commit is also
outside this Module result rule and remains subject to the ordinary Block
reference validation instead.

The trusted Core resolver is implemented, but the Media capability operations
are not yet connected to the Extension application binary interface (ABI),
which Dolly carries over its versioned Extension process protocol. The current
project therefore MUST NOT claim isolated Extension Media read conformance. The
future wire schema must enforce the scope above before exposing Media bytes or
provider access.

## 5. Crop contract

A crop is the versioned fixed-point rectangle `image_rect_v1`: four integers
`x0`/`y0`/`x1`/`y1` on a `0..=1_000_000` grid of upright display space, with
`x0 < x1` and `y0 < y1`, right and bottom edges exclusive. Fractions are never
stored: a coordinate is an integer count of millionths. The wire shape is
closed (`kind: "image_rect_v1"`, exactly those five fields), and the shared
materializer in `src/core/block-content.ts` (`materializeCropBounds`) computes
pixels once for every consumer.

For an image with display width `W` and height `H`, all four edges are computed
independently with integer arithmetic:

```text
left   = clamp(floor(x0 * W / 1_000_000), 0, W)
top    = clamp(floor(y0 * H / 1_000_000), 0, H)
right  = clamp(ceil (x1 * W / 1_000_000), 0, W)
bottom = clamp(ceil (y1 * H / 1_000_000), 0, H)
width  = right - left
height = bottom - top
```

The multiplication must not overflow: coordinates are at most `1_000_000` and
the supported display dimension ceiling is the safe JSON integer limit
`9_007_199_254_740_991`, with intermediates kept exact. The converted rectangle
MUST stay within the original image and have positive integer width and height.
Rounding the width or height directly is not conformant, because it can
disagree with independently rounded edges. A crop that becomes empty after the
decoder's bounds checks fails closed (`EMPTY_CROP` guard); for any crop this
runtime accepts it is provably non-empty. A stored legacy float-scale rectangle
(`topLeft`/`bottomRight` doubles) is never reinterpreted: every entry point
refuses it as an invalid `image_rect_v1` instead.

A crop:

- does not create another `mediaId`;
- does not create a `MediaView` or `viewId`;
- does not create a derived-object identity;
- does not create a resource node or dependency edge; and
- does not create another local or remote object.

The initial contract supports a crop only through a short-lived signed request
whose storage adapter explicitly declares exact signed-crop support with
`supportsSignedCrop: true`. The adapter receives the independently rounded pixel
edges above and MUST encode that exact rectangle.

A cropped `inline` grant is unsupported. A cropped `public-url` grant is also
unsupported. Either request MUST fail visibly; Dolly MUST NOT return the full
original, create persistent cropped bytes, or ignore the crop.

## 6. Storage records

Each Media item has at most one original Media storage record for each adapter.
Concurrent attempts to create a second record for the same pair MUST return the
existing result or a conflict. A crop never changes this rule.

The persisted record uses `dolly.media-storage-record/4`. It contains an opaque
`storageRecordId`, `mediaId`, `adapterId`, storage `visibility`, upload and
deletion progress, the original-object locator, and exact-object metadata. Its
state is `uploading`, `upload-failed`, `available`, `deleting`, or
`delete-failed`. Failed operations record their attempt count, whether retry is
permitted, the next attempt time when applicable, and a stable error code.
These fields describe one original object; they do not create another object or
Media identifier.

A persistent storage record also contains the storage namespace and
`objectVersioning`. With versioning enabled, an available record must contain
the exact `objectVersion`. With versioning disabled, it must instead contain an
Entity Tag in `entityTag`, and deletion must require that exact value as the
precondition. Dolly MUST NOT blindly delete the current object at an unversioned
locator because another writer could have replaced it.

The locator MUST NOT contain credentials, a scheme, a query string, a signed
URL, or crop parameters. Expiring access data belongs only in a provider access
grant. Storage records are internal and MUST NOT be sent to Extensions or model
providers.

An object version and an Entity Tag (ETag) are different. For Alibaba Cloud
Object Storage Service (OSS), `versionId` selects a stored object version and
must be used for version-specific reads and deletion. An ETag is integrity or
cache metadata and MUST NOT be substituted for `versionId`; for an unversioned
adapter it is the exact conditional-delete precondition instead.

## 7. Provider access

A **provider access request**, represented by `ProviderAccessRequest`, names
`mediaId`, an optional normalized crop, a host-assigned `requestId`, one
recipient, and an ordered `acceptedAccessModes` array. The
`signedUrlExpiresInSeconds` field is required only when the request accepts a
private signed URL; it describes the URL's validity window, not a Media
collection deadline. The trusted runtime validates all fields and chooses the
first access mode allowed by storage and recipient policy.

The current grant schema is `dolly.media-access-grant/5`. Its selected
`accessMode` is:

| Method | Result | Crop support |
| --- | --- | --- |
| `private-signed` | Short-lived Hypertext Transfer Protocol Secure (HTTPS) URL, `leaseId`, and `expiresAt` | Only when explicitly declared by the adapter |
| `public-url` | HTTPS URL from explicitly public storage and `leaseId` | Unsupported; disabled unless the trusted host sets `allowPublicProviderUrls: true` |
| `inline` | Base64 bytes and inspected MIME media type | Unsupported; contains neither `leaseId` nor `expiresAt` |

Remote paths and non-HTTPS URLs MUST be rejected. A signed URL and its query
string are credentials: logs, errors, traces, Block content, and history MUST
redact them.

Before issuing a URL grant, Core creates an access lease that keeps the one
Media resource node reachable. No crop node exists. The lease is bound to the
grant's `leaseId`, `requestId`, recipient, and Media identity. Inline access
uses a temporary read access lease (`media-read`) while Core verifies and copies
the original bytes. That lease prevents collection during the copy and is
released before the inline grant returns. Inline access creates no
`ProviderAccessRecord` and exposes neither `leaseId` nor `expiresAt` in the
grant.

A **provider access record**, represented by `ProviderAccessRecord`, is the
persisted record that tracks a URL grant and its exact access lease. It stores
the lease, Media, optional crop, request, recipient, `accessMode`, optional
`signedUrlExpiresAt`, and `requestStatus`. It never stores the URL or inline
bytes. The two request statuses are `awaiting-result`, when the trusted host has
not reported the provider request result, and `result-unknown`, when a provider
fetch may still be in progress or its result is unknown.

Only the trusted host may call `recordProviderAccessOutcome` with the exact
`leaseId`, `requestId`, and recipient. A matching `not-sent` or `finished`
outcome removes the record and releases the lease. A
`fetch-status-unknown` outcome changes the record to `result-unknown` and
retains it. Signed-URL expiry, public-URL configuration, local cancellation,
or restart MUST NOT release the lease by themselves. After an authorized manual
verification, the trusted host may record the matching terminal outcome. This
rule is deliberately conservative because a URL expiry does not reveal whether
an earlier provider fetch still reads the Media item.

## 8. References and deletion

A **strong reference** is a persistent record-to-target reference that keeps the
target and all of its transitive dependencies reachable until that record
removes it. "Strong reference" is the standard garbage-collection and
ownership term for this behavior. An **access lease** is a temporary strong reference with its
own identity, scope, and optional expiry time. These concepts are defined
transactionally in `core-runtime.md`.

Each Media item has exactly one resource node in the reference graph. A
reachable Block adds a dependency edge to the Media identities in its content.
Crops and Media storage records never add
nodes. A storage write, signed access request, or deletion may use a temporary
lease on the Media node.

Media is collectible only when no strong reference, retained Block record, or live
access lease refers to it. An unreachable Block MUST be removed before the Media
it references. Collection MUST prevent new strong references, access leases,
and Block dependencies
from being added until deletion either completes or is cancelled.

Before any deletion side effect, the runtime MUST persist the Media registration
in `deleting` state and each storage record in `deleting` state while retaining
its locator and object version. Media in `deleting` state is unavailable for new
references or access grants. The runtime then calls each adapter idempotently,
treats a confirmed not-found result as success, and removes a storage record
only after absence is confirmed and that progress is persisted.

An adapter failure is persisted as `delete-failed`. A retryable failure records
`nextDeleteAttemptAt`; startup recovery or a later collection pass retries it
only after that time. A non-retryable failure, including denied permission,
remains visible until an operator corrects the cause and explicitly requests
`retryDeletion`. Explicit retry also permits an operator to retry earlier than
the recorded time when doing so is justified.

Automatic recovery continues only when every failed storage record for that
Media item is retryable and its next attempt time has arrived. A future attempt
time or any non-retryable record keeps the Media registration in `deleting`
state for a later recovery pass or explicit retry.

After every storage record is confirmed absent, the runtime deletes the local
original bytes, removes the resource node and Media metadata, changes the
registration to `deleted`, and persists that result. Repeating any confirmed
delete or recovering from the last `deleting` snapshot MUST be idempotent.

Missing delete permission MUST NOT cause Dolly to discard the storage record or
claim that remote bytes are gone. Retryable failures use bounded backoff;
permission failures require explicit operator action after permissions change.

## 9. Durability and crash recovery

Persistent operation stores Media metadata, reference-graph state,
`ProviderAccessRecord` values and their access leases, and original local bytes
across process restart. Metadata and reference changes share the Core state
commit boundary; startup verifies that the required bytes exist. Volatile and
persistent components MUST NOT be combined into a false durability claim.

On restore, every persisted provider access record must match its exact access
lease, request, recipient, Media item, and access mode. A private signed URL's
`signedUrlExpiresAt` remains historical request metadata after restart; it does
not authorize automatic lease release. An `awaiting-result` or `result-unknown`
record remains until the trusted host records a matching outcome or authorized
manual verification supplies one.

An interrupted `media-read` lease has no copied bytes or external provider
request that can survive a process restart. Restore therefore releases that
temporary lease after validating it, while URL-provider access records remain
retained as described above.

After Core state is parsed and validated, a runtime with Media enabled first
removes expired compact deleted-registration records, recovers registrations
already in `deleting` state, completes recoverable `pending` registrations,
verifies bytes for available Media, reconciles persistent uploads, and only
then reconciles Page topology.
Deletion recovery must run first because an interrupted deletion may have
already removed local bytes while the last durable Core state still says
`deleting`; treating that state as an available-Media integrity failure would
prevent the idempotent recovery that resolves it.

On Portable Operating System Interface (POSIX) systems, the file-backed Media
byte store synchronizes its directory after creating a hard link and after
deleting a directory entry. The file-backed Core state store synchronizes the
parent directory after atomically renaming a state file. This complements file
content synchronization and closes the unsynchronized directory-entry window
for those operations under POSIX filesystem semantics. Windows keeps its
existing atomic file operations and does not use POSIX directory handles.

Persistent storage writes and deletes require durable intent before the external
side effect. Before the first metadata read or write, `MediaStore` persists the
planned locator, storage namespace, object-versioning mode, upload state, and a
storage-operation access lease. The adapter MUST create that planned locator
only if it is absent and MUST attach enough immutable metadata for a later HEAD
request, or an equivalent metadata-only read, to compare `storageRecordId`,
digest, byte length, MIME media type, and storage-namespace digest.

Every persistent storage request is bounded by `timeoutMs` and an
`AbortSignal`. Recovery performs metadata reconciliation before a conditional
create and again after either a response or an error whose effect may be
uncertain. Matching metadata completes the one storage record; absent metadata
permits a conditional create; conflicting metadata is a permanent visible
failure and MUST NOT be overwritten or deleted. Retrying MUST NOT create a
second original storage record.

A versioned object is read and deleted by its exact `objectVersion`. An
unversioned object is deleted only with its exact `entityTag` as a conditional
precondition. Adapter absence, a changed storage namespace, or a changed
object-versioning mode fails before external I/O. Cancellation of a dispatched
upload likewise reconciles metadata before deleting the exact matching object.

The integrated `MediaStore` path persists and recovers upload and deletion
progress during startup. A storage adapter with `durability: persistent` is
accepted only when it declares a storage namespace and object-versioning mode
and implements `planOriginal`, `putOriginalIfAbsent`, and `headOriginal` in
addition to bounded exact deletion. A storage adapter with
`durability: volatile` may be paired only with a volatile `MediaStore` and has
no restart-recovery claim. The former standalone storage lifecycle
implementation has been removed; the integrated path is the sole Media storage
lifecycle implementation.

## 10. Alibaba Cloud Object Storage Service requirements

Alibaba Cloud Object Storage Service (OSS) is an optional storage target. It
MUST use a private bucket by default. One Media item has one original OSS object
for that adapter, and crop access MUST reuse that original object.

For OSS, the persisted storage namespace must identify at least the service,
endpoint and region, account, bucket, configured object-key prefix, and
addressing mode without containing credentials. Neither credentials,
`adapterId`, nor a process-local adapter instance proves that recovery addresses
the same bucket and prefix. Recovery must reject a changed storage namespace
rather than retrying an upload or deletion against a different location.

When a model provider must fetch the object, Dolly issues a short-lived signed
Hypertext Transfer Protocol Secure (HTTPS) GET URL. Crop processing is encoded
as a signed URL query parameter. It is a temporary request for part of the same
original object; it does not create, upload, or retain a cropped OSS object and
does not create another Media identity. The query parameters MUST be included
before signing and covered by the signature.

The URL expiry does not release the associated Media access lease. If the host
does not receive a trusted provider result, it records an unknown fetch outcome
and retains the Media until it can record a matching trusted completion or an
authorized operator verifies the result. Public OSS URLs are not a workaround:
provider access by public URL is disabled unless the trusted host explicitly
enables it, and an enabled public URL has the same completion requirement.

Any future runtime client setup MUST explicitly require `secure: true` and
Signature Version 4 (V4) before OSS can be enabled. Security Token Service
(STS) short-lived credentials SHOULD be preferred over long-lived access keys.
Credentials remain in host secret storage and never enter an Extension
configuration or Block.

The minimum object-prefix permissions are:

- `PutObject` to store the original;
- `GetObject` to read it or authorize a signed read; and
- `DeleteObject` to collect it.

Read and write permission alone is insufficient. Operators must grant
`DeleteObject` for Dolly's configured prefix before enabling OSS; otherwise
collection remains in a visible failed state and the object continues to incur
storage and retention risk. Dolly MUST NOT make a private bucket public to work
around missing read or delete permission.

`ListObjects` is not required for ordinary use. It MAY be granted only for an
explicit reconciliation job and only for Dolly's configured prefix. Bucket
administration and public-access policy changes are not required.

The adapter records OSS `versionId` separately from ETag and includes
`versionId` in signed reads and deletion when present. A query-bearing signed
URL is never persisted as the locator.

Every persistent deletion MUST have a finite timeout and a cancellation signal.
Timeout or cancellation after dispatch is an uncertain result, not proof that
the object remains or was deleted; recovery must query or idempotently retry the
exact locator and version, or the exact unversioned Entity Tag precondition,
under the same persisted storage namespace.

The current adapter emits the OSS image-processing anchor `g_nw`. Deterministic
tests verify the software development kit (SDK) call arguments, but no official
live-service test has yet proved the resulting pixels. Dolly MUST NOT claim that
`g_nw` implements this specification's crop origin and edge semantics until a
live test fetches and inspects a non-uniform image.

`AliOssDirectObjectStore` is a direct OSS helper for trusted host code, not a
`MediaStore` adapter. `MediaStore` does not accept it and makes no
crash-recoverable persistent-Media claim for objects created through it. It is
therefore not evidence that the persistent-backend contract is implemented:
there is no accepted OSS backend with a declared storage namespace and
object-versioning mode, locator planning, conditional creation, metadata
reconciliation, bounded exact deletion, unversioned Entity Tag deletion, or a
trusted runtime client factory. No official-service live test has validated
upload recovery, signature behavior, crop pixels, or cleanup for such a
backend.

The generic persistent-adapter contract requires a backend to enforce
`expectedEntityTag` when deleting an unversioned object. The official OSS
[`DeleteObject` reference documentation](https://www.alibabacloud.com/help/en/oss/developer-reference/deleteobject)
and the documented `ali-oss` deletion options establish version-specific
deletion through `versionId`, but do not establish an unversioned deletion
precondition that compares an ETag. That is insufficient evidence to claim
exact unversioned deletion for OSS. Dolly therefore keeps the OSS adapter
unavailable rather than issuing an unconditional delete that could remove a
replacement object.

## 11. Security requirements

Raw path or URL text is data, not authorization. All ingestion paths require an
authorized source, bounded inspection, and the network and filesystem checks in
`security-operations.md`. Active formats are denied by default. Media bytes,
inline Base64 data, credentials, signed URLs, headers, and unrelated host paths
MUST NOT appear in operational logs.

A raw `mediaId` is also data, not authorization. Core can share that identifier
inside one instance for validated Block references, while an untrusted
Extension still requires the delivered-Block-scoped capability in Section 4.
Storage records, direct Media-store methods, and provider access records MUST
remain behind the trusted-host boundary.

## 12. Current implementation status

The command-line interface (CLI) and runtime currently support disabled Media
or persistent Media. Persistent Media stores original bytes on disk, stores
metadata in Core state, verifies bytes at startup, and uses the bounded image
inspector. This path is usable and has deterministic restart tests. Direct
`MediaStore` users may instead choose volatile Media with an in-memory byte store.

The current isolated Extension process path does not yet receive a
delivered-Block-scoped Media capability. This implementation gap is visible:
the current bootstrap rejects configured Modules before execution rather than
giving them direct Media-store access. Trusted Core Block validation is not
evidence that Extension Media access is implemented.

The Core Module result commit path now rejects a result whose source differs
from the Delivery Claim's consumer Module, or whose Media references are not
valid reuse of that Claim's input references. It repeats that validation before
resuming a `prepared` commit record. This Core check is required before Module
execution or Extension Media read is enabled; it does not enable Module
execution, Media upload from a Module result, or an isolated Extension Media
read capability.

The enabled path uses `dolly.media-store/9` inside `dolly.core-state/18`. It
persists upload and deletion state before external side effects, replays
interrupted deletion and registration, verifies available local bytes, and then
reconciles persistent uploads. Retryable and non-retryable failures remain
visible as described in Sections 8 and 9.

URL-based provider access persists its access lease and request status with the
Media store. The trusted host records `not-sent`, `finished`, or unknown fetch
outcomes through `recordProviderAccessOutcome`; only matching known outcomes
release a lease. Inline access verifies bytes before making a Base64 copy and
uses a temporary `media-read` lease only while that copy is in progress; it
does not persist a provider access record or expose a grant lease. Public
provider URLs remain disabled unless the host explicitly enables
`allowPublicProviderUrls`.

An internal model-broker candidate now composes that verified inline copy with
the exact delivered Block and authenticated Module Run. Its only installed
mapping is an uncropped `image/png` copied into the separately versioned
OpenAI-compatible inline-image strategy. It does not expose `MediaStore` or the
copy to an Extension, and the current model-operation capabilities continue to
reject Media. Consequently this composition is deterministic evidence for the
Host boundary, not evidence that configured Modules or isolated Extensions can
yet ask a model to inspect Media.

The product configuration schema is `dolly.instance/9`. When Media is enabled,
it requires limits for individual and total bytes, registration records,
storage records, provider access records, compact deleted-registration
retention, active ingress capabilities, concurrent ingress operations, and
capability lifetime. Lower limits may be applied when restoring existing state;
the state remains readable and removable, while new admissions fail at the
configured boundary.

The Ali OSS adapter has deterministic software development kit (SDK) contract
tests for original upload, Signature Version 4 signed version and crop queries,
deletion, not-found handling, and visible permission denial. These tests use a
client test double; they are not evidence from the official OSS service.

Deterministic tests prove the generic persistent-adapter contract with test
doubles, including lost responses, restart reconciliation, storage-namespace
mismatch, conditional creation, exact-version or Entity Tag deletion, timeout,
cancellation, and conflicting metadata. No persistent provider adapter is
therefore enabled merely because it can upload an object; it must implement the
complete contract in Section 9.

The Ali OSS adapter is not connected to command-line configuration or runtime
startup and is rejected by `MediaStore` for the missing persistent recovery
operations listed in Section 10. Dolly does not silently fall back to local
storage, public access, or a non-recoverable upload.

Dolly MUST NOT describe OSS storage as usable until all of these are complete:

- runtime configuration and secret loading;
- explicit secure transport and V4 signing setup;
- the complete persistent recovery adapter contract, including a safe OSS
  conditional-create operation and metadata reconciliation;
- a storage namespace for the configured endpoint, bucket, object-key prefix,
  and addressing mode;
- finite deletion timeouts, cancellation, and exact version or Entity Tag
  deletion;
- operator-visible status, documented trusted outcome recording after an
  uncertain provider request, and denied-delete recovery; and
- a live signed-crop pixel test using a non-uniform image.

## 13. Snapshot versions and migration

Current closed snapshot and message versions are:

| Stored or exchanged value | Current schema |
| --- | --- |
| Instance configuration | `dolly.instance/9` |
| Media record | `dolly.media/2` |
| Media store snapshot | `dolly.media-store/9` |
| Media registration record | `dolly.media-registration/4` |
| Provider access grant | `dolly.media-access-grant/5` |
| Provider access record | An entry in `dolly.media-store/9`; it has no separate schema |
| Reference graph snapshot | `dolly.reference-graph/4` |
| Core state document | `dolly.core-state/18` |
| Block store snapshot | `dolly.block-store/3` |
| Delivery store snapshot | `dolly.delivery-store/6` |
| Media storage record | `dolly.media-storage-record/4` |

The following are rejected predecessor schemas, not additional current
schemas. Current readers explicitly reject the immediately preceding
`dolly.instance/8`, `dolly.media/1`, `dolly.media-store/8`,
`dolly.media-registration/3`, `dolly.media-access-grant/4`,
`dolly.media-storage-record/3`, and
`dolly.reference-graph/3` versions without
automatic migration. They also reject Block store version 2, Delivery store
versions 4 and 3, Reference graph version 2, and the former
`dolly.lifetime-graph/3` snapshot. Older and unknown versions and unknown fields
fail closed as well.

The Core state document is the one exception to rejection without a path
forward, and it is still not an automatic migration. Reading
`dolly.core-state/15` or `dolly.core-state/16` fails closed with
`CORE_STATE_MIGRATION_REQUIRED`; an operator runs the explicit offline
migration to `dolly.core-state/18` described in `core-runtime.md` Section 7.7
before starting the instance. Version 14 and earlier are rejected outright.

There is no automatic migration from the rejected multi-object model. An
offline migration tool would need to validate each original Media item, discard
query-bearing pseudo-locators, map only real original objects to storage
records, and convert valid crops back into reference data. It MUST NOT preserve
`viewId` as another Media identity.

## 14. Required evidence

Conformance requires deterministic tests for:

1. immutable Media and one `mediaId` across Block, storage, and provider access;
2. atomic rejection of missing Media and invalid crops;
3. independent rounding of all four pixel edges, including half-pixel cases;
4. proof that a crop adds no Media, resource node, or storage record;
5. one original storage record per Media and adapter under concurrency;
6. process exit after pending-registration persistence, byte write, strong
   reference creation, and available-state persistence; equal-input retry keeps
   one `mediaId`, conflicting input fails, and missing bytes remain visible;
7. exact rejection of the immediately preceding Media, registration, storage,
   provider-access, Media-store, Core-state, and instance-configuration schema
   versions listed in Section 13;
8. signed grants only from adapters that explicitly declare exact crop support;
9. rejection of cropped inline and public access without silent fallback;
10. `ProviderAccessRecord` and URL-grant access leases: private signed URL
    expiry without automatic release, default public-URL denial, explicitly
    enabled public URLs, request/recipient fencing, `not-sent` and `finished`
    release, unknown-fetch retention, authorized manual verification,
    cancellation, and restart; inline copy protected by a temporary
    `media-read` lease with no provider record or outgoing grant lease,
    same-length byte-corruption rejection, collection race protection, and
    interrupted-read recovery;
11. signed URL and secret redaction;
12. persistence before deletion, lost local byte and adapter responses, retry
    only when due, explicit retry after denied permission, failure to persist
    the final state, partial progress across adapters, and concurrent recovery;
13. persistent write and delete recovery at every crash boundary, including
    timeout and cancellation after dispatch;
14. storage namespace matching across restart and rejection of a changed
    bucket or object-key prefix;
15. visible missing `DeleteObject` permission without lost storage records; and
16. operation with Put, Get, and Delete permissions but no List permission;
17. versioned exact-object deletion and unversioned Entity Tag conditional
    deletion;
18. admission limits under concurrency, compact deleted-registration expiry,
    and restore under lower configured limits;
19. a Media ingress capability before local-file, remote-fetch, or stream I/O,
    including subject, mode, registration, byte, concurrency, and expiry bounds;
20. generated ID namespace and 128-bit sequence persistence, mismatch,
    exhaustion, and restart without reuse;
21. strong-reference lifetime through Block and Delivery reachability in
    `media-strong-reference-lifetime.test.ts`;
22. instance-scoped Media identifier reuse through delivered Blocks while raw
    `mediaId` access is denied, including cross-session, cross-Module,
    undelivered-Block, broadened-crop, guessed-ID, and revoked-capability cases; and
23. Module result validation: source equality with the Delivery Claim consumer,
    rejection of an undelivered Media reference, valid reuse from an uncropped
    input, rejection of a full-image output or larger/combined crop when all
    inputs are cropped, and the same checks when a `prepared` record is
    recovered. The test must also show that a trusted Core direct Block commit
    is not incorrectly limited to Claim input Media.

The optional live OSS test MUST create one uniquely prefixed original object,
sign a crop of a non-uniform image, fetch it, verify dimensions and selected
pixels, and delete the exact version during cleanup. Failure to confirm cleanup
is a test failure. The default test suite MUST remain independent of private
credentials and paid services.

## 15. Rejected model

The earlier split into public asset, view, derived-object, and storage-location
identities is rejected. In particular, `MediaView`, `viewId`, and query-bearing
pseudo-object identities are not part of this contract. The single Media record,
optional crop data, Media storage record, and provider access grant cover the
required behavior with fewer states and fewer invalid combinations.
