# ADR-0003: One Media identifier within each Dolly instance

Status: Proposed

Date: 2026-07-25

Architecture decision record (ADR) 0003 proposes the instance-scoped identifier and
lifetime model for Media. It has no normative force while its status is
Proposed; `docs/spec/media.md` is the detailed Draft contract.

## Context

Dolly must keep original media bytes, let a Block request a crop, store those
bytes through an adapter, and give a model provider temporary access. The
previous design assigned separate identifiers to each concern. That
created unnecessary reference state and allowed a query string to look like a
stored object even when no such object existed.

The user-visible model is simpler: a Block refers to one Media item and may
request a crop. Storage progress and temporary provider access are internal
records around that one identity.

## Terms used by this decision

- **Media** is one immutable original byte sequence plus inspected metadata.
  Its only Core-managed identifier is `mediaId`, scoped to one Dolly instance.
- A **Media storage record** is the internal record for one adapter's original
  object for one Media item. It is not another Media identity.
- A **provider access grant** is the result for one named provider request to
  read one Media item. It is either inline bytes, a private signed URL, or an
  explicitly enabled public URL.
- A **provider access record** is the persistent `ProviderAccessRecord` for a
  URL grant and its access lease. It exists because a provider request can
  outlive the local call that issued the URL; it never stores the URL or inline
  bytes.
- A **storage namespace** is non-secret canonical configuration for the
  provider, endpoint, account, container, prefix, and addressing mode of a
  persistent adapter. The source field `storageNamespace` stores that value so
  recovery can prove it is addressing the same location.

These terms use the ordinary words Media, record, grant, and namespace. The
literal source identifiers above distinguish closed wire values; they do not
introduce additional Media objects.

## Rejected proposal

The earlier proposal introduced `MediaAsset`, `MediaView`,
`MaterializedRepresentation`, and `StorageBinding`. This decision rejects that
split. Those names describe no Media objects in the new contract, and their
identities MUST NOT be preserved as parallel identifiers.

## Proposed decision

1. **One identifier.** Media has one Core-managed identifier, `mediaId`, within
   one Dolly instance. A Block's
   `media-reference` can contain a normalized crop, but the crop is request data
   rather than a second Media item, reference-graph node, or stored object.
2. **One original object per adapter.** A Media item has at most one storage
   record for each configured adapter. A crop neither creates nor requires a
   second original object. It can use a signed request only when the adapter
   declares exact crop support; cropped inline and public-URL access fail
   rather than silently returning the full original.
3. **Explicit durability.** Media durability is `volatile` or `persistent`.
   The selected value applies together to Media metadata, reference-graph
   state, and original bytes. A volatile Media store accepts only volatile
   adapters. A persistent Media store accepts only persistent adapters with
   planned locators, conditional creation, metadata-only reconciliation, a
   storage namespace, object-versioning declaration, bounded requests, and
   exact deletion.
4. **Recovery before side effects.** Before persistent adapter input/output
   (I/O), the Media store persists the planned locator, storage namespace,
   versioning mode, and storage-record state. Recovery compares the namespace,
   reads object metadata, and either recognizes the planned object, conditionally
   creates an absent object, or reports a visible conflict. It never overwrites
   or deletes a conflicting object.
5. **Exact deletion.** A versioned object is read and deleted using its exact
   object version. An unversioned persistent object requires an exact Entity Tag
   (ETag) delete precondition. This prevents a delayed cleanup from deleting an
   object that another writer replaced at the same locator.
6. **Reachability, not counters.** Each Media item has one resource node.
   Persistent strong references and temporary access leases make it reachable.
   An available Media registration record holds its initial strong reference
   while `holdsRegistrationReference` is true; it can release that reference
   only after another persistent strong-reference path exists. A URL provider
   access record retains its access lease until a matching trusted `not-sent` or
   `finished` request outcome is recorded. An unknown fetch, signed-URL expiry,
   cancellation, and restart do not release it. Public URLs are disabled unless
   the host explicitly enables them; inline bytes have no persistent record or
   outgoing grant lease. Core uses a temporary `media-read` lease only while it
   verifies and copies inline bytes, then releases it before returning the copy.
7. **Shared Core identifier, scoped Extension authority.** Core validates and
   reuses `mediaId` across Blocks and Modules within one instance. An untrusted
   Extension does not gain byte or URL access merely by knowing that identifier.
   The Extension process host must derive an opaque Media capability from an
   exact Media reference in a Block already delivered to that authenticated
   Module job. It must reject a guessed identifier, another Module or session,
   an undelivered Block, or a crop broader than the delivered reference.

The current closed values are `dolly.media/2`,
`dolly.media-registration/4`, `dolly.media-storage-record/4`,
`dolly.media-access-grant/5`, and `dolly.media-store/9`, nested in
`dolly.core-state/17` with `dolly.reference-graph/4`. Instance configuration
uses `dolly.instance/9`.
Readers reject the immediately preceding values rather than guessing a
migration.

## Alibaba Cloud Object Storage Service

Alibaba Cloud Object Storage Service (OSS) is optional and private by default.
One Media item would use one original OSS object for its adapter. A crop is a
short-lived signed Hypertext Transfer Protocol Secure (HTTPS) request for the
same original object; it does not upload, retain, or identify a cropped object.

`AliOssDirectObjectStore` is a direct OSS helper for trusted host code, not a
Media store adapter. The Media store does not accept it and makes no
crash-recoverable persistent-Media claim for objects created through it. It
therefore does not establish the persistent-adapter contract: storage
namespace, object-versioning declaration, locator planning, conditional
creation, metadata reconciliation, bounded exact deletion, and a trusted
runtime client factory.

The generic contract also requires an adapter to enforce an ETag precondition
for unversioned deletion. The official OSS
[`DeleteObject` documentation](https://www.alibabacloud.com/help/en/oss/developer-reference/deleteobject)
documents `versionId` selection but does not establish an ETag precondition for
an unversioned delete. The documented `ali-oss` deletion options likewise do
not establish that operation. This does not assert that no undocumented service
mechanism exists; it means the available official evidence is insufficient for
Dolly's exact-deletion guarantee. OSS therefore remains unavailable until an
officially supported and tested operation satisfies that contract.

When OSS becomes available, least privilege for the configured prefix requires
`PutObject`, `GetObject`, and `DeleteObject`. Read and write permission alone
is insufficient: missing `DeleteObject` must leave a visible failed storage
record, never cause Dolly to claim that bytes were removed. Signed URLs must be
short-lived, credentials remain in host secret storage, and live validation
must use a non-uniform image to check exact crop pixels and cleanup. Their
expiry is not a provider-completion signal and must not release Media access.

## Consequences

Block content, the reference graph, Media storage records, and provider access
grants all use the same `mediaId`. Extensions neither receive object-storage
credentials nor choose locators, storage visibility, or provider access mode.
The runtime has fewer invalid state combinations, and a user requests a crop
without managing storage objects.

The trusted Core resolver can validate a shared Media identifier during Block
commit, but it is not an Extension byte-read interface. The delivered-Block
Media-capability wiring in the Extension application binary interface (ABI) is
still pending. Until it is implemented and tested, isolated Extensions must not
be described as having Media access.

Persistent adapters have a deliberately demanding contract. An adapter that
can upload bytes but cannot recover an uncertain operation is not a persistent
adapter for Dolly. This is a safety boundary, not a reason to downgrade a
persistent request into a volatile or public operation.

## Required evidence before acceptance

- one `mediaId` across Block references, storage records, and provider access;
- independently rounded crop edges and proof that crops add no resource node or
  storage record;
- registration, deletion, and persistent upload recovery across every durable
  side-effect boundary;
- changed storage-namespace rejection before external I/O;
- conditional creation, metadata conflict, versioned exact deletion, and
  unversioned ETag-precondition tests using deterministic adapters;
- strong-reference and provider-access-record lifetime tests across restart,
  including unknown fetches that remain retained after signed-URL expiry;
- temporary `media-read` lease coverage for inline-copy/collection races,
  same-length byte corruption, and interrupted-read recovery;
- instance-wide identifier reuse through Blocks together with denial of raw-ID,
  cross-session, undelivered-Block, and broadened-crop Extension access;
- visible denied-delete behavior that retains the storage record; and
- an explicit opt-in OSS live test only after OSS implements the contract. It
  must fetch a signed crop of a non-uniform image, verify the selected pixels,
  and confirm exact-object cleanup.
