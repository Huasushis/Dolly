# LevelUpper Cross-Instance Bridge

Status: **normative for LevelUpper research prototypes; not a Dolly v1 product
guarantee**. LevelUpper remains outside the stable Runtime until its Network
Broker, protocol, hostile-peer suite, and promotion evidence pass.

`REQ-LEVELUPPER-001` — LevelUpper is an authenticated asynchronous Page-content
bridge with durable per-direction outbox and inbox. It is not a distributed
Page, database, cursor, transaction, or global Block identity system.

`REQ-LEVELUPPER-002` — Every imported object receives new local Core identity
and local authorization. A remote Block, Asset, Action, producer, trace, Page,
or capability identity MUST NOT become authoritative by crossing the bridge.

`REQ-LEVELUPPER-003` — Transport retries MUST be idempotent per foreign entry,
ACK only after durable local Core ingress, and terminate loops with a
bridge-owned origin/path/hop contract independent of local Core trace.

`REQ-LEVELUPPER-004` — Listener/client determines who opens a connection only.
After authenticated share negotiation, each configured direction is governed
symmetrically by its own policy, revision, sequence, quota, and ledger.

`REQ-LEVELUPPER-005` — A prepared outbound occurrence MUST NOT become network
sendable until its source Core Activation is authoritatively committed. A lost
or unknown disposition is a send fence, not permission to publish early.

`REQ-LEVELUPPER-006` — An exporting LevelUpper Module MUST declare the fixed
`fenced_replay` Activation-ledger contract in this chapter. Asset requests and
binary chunks MUST be bounded, share/session/epoch-bound, non-overlapping, and
completed only after exact coverage and digest verification.

## 1. Semantic model and non-goals

LevelUpper exports selected local Page occurrences as portable content and
imports an authorized peer's portable content as new local Blocks and
Deliveries. It does not create a global Page ID, cross-node `commit_seq` order,
shared cursor, cross-instance BlockRef, distributed ACID commit, exactly-once
network, Module private-state replication, remote deletion, or automatic
remote Action execution.

A display/source alias is separate from a Module ID and peer security identity.
It may be shown downstream as untrusted provenance but cannot authorize a
share. A wire batch is a transport optimization, not one giant local Block.
The initial profile has only `portable_parts`; a future digest-only
notification requires its own wire, authorization, import, and retention
contract before it can enter the configuration enum.

## 2. Required Host Network Broker

The current stable Host has no safe listener, port reservation, inbound
identity, or TLS-key capability. LevelUpper therefore depends on a future Host
Network Broker rather than unrestricted Extension sockets.

The Broker MUST:

- reserve exact listen/connect endpoints during configuration prepare and
  reject conflicts across Modules and instances it manages;
- hold TLS private keys and peer pin policy outside the Extension;
- perform TLS 1.3 peer authentication, connection limits, revocation, and
  accept/connect authorization;
- return a connection-bound framed-stream capability rather than a raw key or
  ambient network grant; and
- fence the stream by Worker epoch, Extension generation, connection epoch,
  peer, and share.

Public discovery and trust-on-first-use are disabled. A peer key change is a
new peer unless an explicit authenticated rotation transaction succeeds.

## 3. Identity and share configuration

Security and transport identities are distinct:

| Identity | Meaning |
| --- | --- |
| `BridgePeerId` | pinned Host-managed peer public-key digest |
| `node_display_name` | untrusted human-readable label |
| `ShareId` / `ShareRevision` | immutable routing/policy relationship |
| `DirectionId` | one stable export/import stream identity inside a share |
| `ShareEpochId` | reset or re-baseline boundary for one direction |
| `LinkSessionId` / `ConnectionEpoch` | one connection and stale-socket fence |
| `ExportSeq` | monotonic occurrence order within a direction epoch |
| `ForeignBlockKey` | portable content key, never a Core Block ID |
| `ForeignEntryKey` | portable occurrence identity |
| `ForeignAssetKey` | portable Asset transfer identity |

Resolved share configuration conforms to `schemas/levelupper-share.schema.json`.
It pins peer identity, listener/connect/both transport role, per-direction
export Pages or remote stream labels, local import Pages, source display alias,
content/metadata/Action/Asset/reference policies, queue/age limits, hop limit,
and strict or loss-tolerant ordering.

One authenticated connection MAY multiplex several shares, but every configured
direction has a unique stable `direction_id`; revision, epoch, ledger,
sequence, hash chain, flow control, Asset transfer, error, and revocation are
isolated by `(share_id,direction_id)`. A bidirectional share therefore has two
different sequence spaces even when both begin at one. Remote stream labels are
routing aliases within that direction, not sequence identity.
Changing a share creates a new revision; an old outbox item retains the policy
and destination under which it was accepted.

Persistent configuration names `network_broker_grant`, a declarative Host
policy reference. It never contains a connection-bound capability token.
After initialize, the Host grants a fresh capability out of band for this
Worker epoch, Extension generation, connection epoch, peer, and share; the
token is not serialized into resolved config, snapshots, logs, or backups.
`org.dolly.validator.levelupper-share@1` rejects duplicate peer/share IDs,
unsafe Page direction aliasing, endpoints with userinfo/query/fragment, a
non-`wss` endpoint, or a share naming an undeclared/unauthorized peer.

Every durable LevelUpper row, pin/ingress/Network-Broker operation identity,
and broker handle is tenant-bound first by the Host tuple
`(daemon_installation_id,instance_id,storage_scope_id)`. `share_id`, peer ID,
foreign keys, and source alias are only secondary keys inside that scope and
MUST NOT select a database tenant or a pin by themselves. When several Modules
share one Extension process or physical database, transactions and background
jobs keep this tuple in every lookup and uniqueness constraint. Two Modules
using the same peer/share text therefore have disjoint outbox, inbox, sequence,
hash, mapping, pin, and capability state. A restore/fork follows the Core scope
identity modes; a fresh-scope fork cannot reconnect an old broker handle or
external peer authority without a new explicit grant.

## 4. Wire profile

The initial research profile uses WSS over TLS 1.3 with mutual public-key
authentication or an equivalent Broker-authenticated stream. Control messages
are strict bounded UTF-8 JCS JSON. Asset bytes use bounded binary frames rather
than Base64 JSON. Compression is off until a bomb-resistant negotiated profile
exists.

Let `lo = max(local_min, peer_min, configured_min)` and
`hi = min(local_max, peer_max)`. Negotiation fails when `lo > hi`; otherwise it
selects `hi`, the highest mutually supported protocol, not the oldest version.
Each effective numeric limit is the minimum of both peers' advertised and the
local configured ceiling for frame bytes/depth, batch entries, in-flight bytes,
Asset size/chunk, and outstanding requests. The selected version, effective
limits, both hello nonces and peer identities are bound into the open-share
policy/transcript digest; swapping a hello or limit set fails negotiation. The
wire semantic validator checks `minimum_version <= maximum_version`, the
selected `protocol_version`, and this transcript binding, preventing silent
downgrade.

The `open_share`/`accept_share` body carries the effective limits and
`negotiation_transcript_digest`. Here `DS(label,value)` means
`SHA256(UTF8(label) || 0x00 || uint32be(n) || UTF8(JCS(value)))`, with `n` the
JCS byte length. The transcript digest is
`DS("dolly.levelupper.negotiation.v1", {"hello_frame_digests": <the two
digests sorted as lowercase UTF-8>, "peer_ids": <the two peer digests sorted
as lowercase UTF-8>, "protocol_version": selected_version,
"effective_limits": effective_limits})`. Either side recomputes it from the two
retained Hello frames; it is not a peer assertion.

Flow control is per direction and connection epoch. A `flow_control` frame
contains a monotonically increasing `credit_revision`; `credit_bytes` and
`credit_entries` are absolute remaining grants, never additive deltas. The
next revision replaces the previous grant, a byte-identical repeat of the
current revision is idempotent, an older revision is ignored, and the same
revision with different values is a protocol error. Credits expire at a new
connection epoch. The sender still enforces configured in-flight hard caps
before every write even when a peer advertises more credit.

`schemas/levelupper-wire-control.schema.json` is the interoperable v1 control
contract. It covers hello, open/accept share, resume checkpoint, portable
content and occurrence entry, Asset offer/request/completion, entry ACK/NACK,
flow control, ping/pong, drain, error, and close. Every frame binds protocol,
session, connection epoch, sender peer, message ID, and canonical digest; every
post-negotiation share body also binds share/revision/direction/epoch. Asset bytes use
the following exact big-endian binary frame; every integer is unsigned and the
frame contains no padding:

```text
magic[8] = "DLYLUA01"
protocol_version:u16
link_session_id:16 raw UUID bytes
connection_epoch:u64
sender_peer_id:32 raw SHA-256 bytes
message_id:16 raw UUID bytes
share_revision:u64
share_id_len:u16 | share_id:UTF-8
direction_id_len:u16 | direction_id:UTF-8
share_epoch_id:16 raw UUID bytes
foreign_asset_key_len:u16 | foreign_asset_key:UTF-8
offset:u64 | length:u32 | chunk_sha256:32 raw bytes | chunk:length bytes
```

The complete frame length MUST equal the header-derived length. Text fields
must satisfy their control-schema types and canonical UTF-8 encoding. A chunk
is accepted only for an outstanding request with the same authenticated peer,
session, connection epoch, message, share/revision/direction/epoch, and Asset key. Its
range must be wholly inside both the request and the retained offer; `length`
must not exceed the negotiated, configured, or offered chunk limits; the chunk
digest must match. Cross-session/share replay is rejected before bytes reach
staging.

Both resolved share limits and negotiated wire limits include
`max_outstanding_requests`; the smaller value applies. Asset-request ranges
MUST be sorted by ascending offset, non-overlapping, and checked with
overflow-safe addition against the retained offer length. The total requested
and in-flight bytes remain under the negotiated credits. `asset_complete` is
accepted only after the exact interval `[0,byte_length)` has been durably
staged without holes, every chunk has passed its digest, and the complete bytes
match the offered content digest. Duplicate identical chunks are idempotent;
overlapping, conflicting, unsolicited, or out-of-bound chunks close or
quarantine the share and never count toward completion.

The frame digest is
`SHA256(UTF8("dolly.levelupper.frame.v1") || 0x00 || uint32be(n) || bytes)`, where `bytes`
is `UTF8(JCS(frame without frame_digest))` and `n` is its byte length. Duplicate
JSON names, non-JCS encodings, out-of-bound numbers, and digest mismatches close
the connection.

Within an export stream:

```text
payload = UTF8(JCS(entry envelope without previous_entry_hash or entry_hash))
prev = 32 zero bytes for export_seq 1, otherwise raw previous SHA-256 bytes
entry_hash = SHA256(UTF8("dolly.levelupper.entry.v1") || 0x00 || prev ||
                    uint64be(export_seq) || uint32be(len(payload)) || payload)
checkpoint = (share_id, direction_id, share_epoch_id, export_seq, entry_hash)
```

An ACK names the exact checkpoint. Sequence reuse with a different hash,
an ACK above the sender's durable high-water after backup restore, or a missing
share derivation key enters `ReconciliationRequired`; neither peer silently
skips or resets history.

`entry_ack` has only the code `LOCALLY_COMMITTED` and must equal the receiver's
durable continuous checkpoint. `entry_nack` uses the closed wire codes and a
`retryable` or `terminal_share_block` disposition. No NACK advances either
peer's acknowledged high-water, releases a pin, skips an export sequence, or
authorizes later entries to overtake a strict gap. Hash/sequence/policy
failures and every terminal NACK enter `ReconciliationRequired`. A deliberate
discard requires a separately authorized bilateral re-baseline transaction
that creates a fresh direction/share epoch and audit record; it is never encoded as a
NACK. `quarantine_gap` means retain the gap and quarantine subsequent entries
for inspection/re-baseline, not silently continue after it.

## 5. Durable outbound pipeline

The exporting Module consumes local Page input through normal Activations:

```text
Observed -> BlockPinned -> OutboxPrepared -> HostCommitted -> Sendable
         -> Offered -> AssetsTransferring -> AwaitingAck -> Acked -> PinReleased
```

Before advancing its local cursor, the Module obtains a bounded Host Block pin
and durably stages an `OutboxPrepared` entry keyed by Activation/Manifest and
the frozen share revision. Its activation-ledger result proves both, but this
state is ineligible for network I/O. Only a committed
`module.activation_disposition`, or an equivalent authoritative
`host.activation.status` result, atomically promotes it to `HostCommitted` and
`Sendable`. An authoritative abort discards the entry and releases the pin;
unknown or quarantined disposition retains the pin for bounded operator
reconciliation and sends nothing. Network transmission is background work
only after `Sendable` and can then continue while disconnected.

Every exporting Module Descriptor requests exactly:

```json
{
  "mode": "fenced_replay",
  "evidence": "activation_ledger",
  "ledger": {
    "namespace": "org.dolly.levelupper.activation",
    "schema_version": "v1",
    "location": "module_state_directory"
  }
}
```

The ledger is keyed by `(activation_id,manifest_digest)` and retains the
frozen share revision, source occurrence, pin operation/result, canonical
outbox entry, and byte-identical Activation result. It is durable before the
result is returned. A same-ID/different-manifest request is a conflict;
re-dispatch returns or reconciles the retained record. Missing/corrupt evidence
never authorizes cursor advancement or network send.

Receiver ACK permits durable local ACK state and pin release. Send with lost
ACK is retransmitted under the same ForeignEntryKey. Pin success followed by
outbox failure leaves an expiring orphan pin; outbox success followed by lost
Activation response is reconciled through the activation ledger. A full
outbox, expired maximum backlog age, or failed pin yields explicit backpressure
or dead-letter disposition and never silent local cursor advancement.

The pin expiry is never shorter than the accepted backlog deadline plus the
configured drain/reconciliation margin. A rollover obtains a second finite
pin with a fresh `host.block.pin` operation ID, durably swaps the outbox's
active pin ID, and only then unpins the old one; changing expiry under the old
operation ID is forbidden. If rollover fails, the entry becomes
`PinUncertain`, transmission stops, and the implementation reconciles the
exact pin and Block before resuming; age expiry cannot silently turn a
previously offered entry into data loss.

## 6. Durable inbound pipeline

```text
Received -> PeerAndShareVerified -> ManifestValidated -> AssetsStaged
         -> AssetsAvailable -> ReferencesResolved -> IngressSubmitting
         -> LocallyCommitted -> Acked
```

The receiver uses a stable ingress idempotency key derived from peer, share,
direction, epoch, and ForeignEntryKey. A lost `host.ingress.submit` response is reconciled
with `host.ingress.status`. ACK is legal only after local Core commit and the
receiver ledger are durable. A wire batch can partly commit; recovery reconciles
each entry and ACKs only the greatest continuous valid checkpoint. There is no
cross-instance multi-Block transaction.

## 7. Portable content and local reauthorization

A stable portable content object conforms to
`schemas/levelupper-portable-block.schema.json`. It carries a foreign Block
key, description, filtered portable Parts, foreign references, content digest,
and source alias. It contains no hop, share, occurrence, or connection state.
Its digest is
`SHA256(UTF8("dolly.levelupper.content.v1") || 0x00 || uint32be(n) || bytes)`, where `bytes`
is `UTF8(JCS(content without content_digest))`.

Each occurrence separately conforms to
`schemas/levelupper-entry-envelope.schema.json`. The envelope carries the
ForeignEntryKey, share/revision/direction/epoch, export sequence, stable content digest,
origin/path/hop state, and hash-chain fields. One content object can therefore
be reused by several occurrences without changing its digest.

Neither object MUST carry a Core Block/Action ID, trusted producer, creation sequence,
local trace or causal parent, Page/Delivery/cursor, schema contract binding,
capability, secret, path, signed URL, or unregistered research hint. The local
import is a fresh trace root. Foreign provenance is namespaced untrusted data;
it does not create a local GC edge or privilege.

### 7.1 Assets

The sender offers foreign key, exact length, content digest, detected media
type, and view. The receiver authorizes quota, transfers verified offset/chunk
ranges to staging, validates total length and digest, and asks its own Asset
Service to sniff and publish the content. Only the returned local Asset ID can
enter the imported draft. Identical bytes across security domains do not imply
shared authorization or expose existence.

### 7.2 Block references

Portable BlockRefs target ForeignBlockKeys. The sender sends the bounded
dependency closure first. The receiver maps a committed dependency to its local
Block ID. Strict mode blocks on a missing dependency; loss-tolerant mode emits
an explicit typed missing-reference value. A foreign ID string is never placed
in the Core `block_id` field.

### 7.3 Actions

The default and only initial online policy is `strip_and_record`: remote Actions
are removed or represented as inert data. Peer authentication is not Action
authority. A future federated-action adapter requires a separate research
feature, bilateral operation allowlist, fresh local ActionDraft, local schema
binding, side-effect ledger, and promotion decision.

## 8. Occurrences, order, and loops

One ForeignEntryKey represents one remote Page occurrence. Retransmission
imports once; two distinct occurrences with identical content remain distinct.
A portable content object can be shared by several occurrence records in one
known batch. Because Core v1 cannot later append an existing foreign Block to a
new Page, a late occurrence on another stream may import a new local Block with
the same foreign-content provenance; LevelUpper MUST NOT pretend their local
Block IDs are equal.

Bridge loop prevention uses:

```text
origin_peer_id, origin_direction_id, origin_share_epoch, origin_entry_key,
visited_peer_path, hop_count, hop_limit
```

Re-export preserves origin by default. A local peer already in the path or a
hop at the limit is rejected. Core local trace is not used because each import
correctly starts a new local trace. `fork_as_new_event` deliberately breaks the
origin and is disabled by default.

The semantic validator requires `hop_count == visited_peer_path.length`, the
origin peer to be the first path element, no duplicate peer, and
`hop_count <= hop_limit`. A forwarding peer appends itself and increments the
count exactly once; it may import an entry at the limit but cannot re-export
it. Origin/path/hop fields are occurrence envelopes and never participate in a
stable content digest.

The named pure validators are part of the wire profile, not informative prose:
`org.dolly.validator.levelupper-content@1` recomputes stable content and Part
schema/Asset bounds, including UTF-8 byte limits for text/descriptions/aliases
and the negotiated aggregate object/frame budget, BCP47-like language tags,
and `x0 < x1 && y0 < y1` for every Asset crop;
`org.dolly.validator.levelupper-entry@1` enforces the
origin/path/hop relationship, previous-hash rule, and entry hash;
`org.dolly.validator.levelupper-wire@1` recomputes the frame digest and binds
an outer share and authenticated sender to the nested entry. Sequence 1 has a
null `previous_entry_hash`; later sequences require the exact prior digest.
For a portable-entry frame, the outer and inner share ID, revision, and epoch
are byte-identical, the sender is the final visited peer, and the referenced
content digest must already be retained or accompany the bounded batch. A
shape-valid disagreement closes or quarantines the share and cannot be ACKed.

Within one content closure, one `foreign_asset_key` denotes exactly one tuple
`(content_digest,byte_length,media_type,view)`; conflicting duplicate metadata
is invalid. The retained wire `asset_offer` must match that tuple byte for byte
(with any transfer-chunk choice bounded separately), and completion/import
uses the sniffed local media type. A crop is valid only for a sniffed raster
image. Neither an entry nor a later offer may reinterpret an existing key.

## 9. Lifecycle and recovery

Graceful stop stops accept/connect and new outbox staging, drains or safely
checkpoints in-flight chunks, persists ledgers/checkpoints, invalidates the
connection epoch, and closes the Broker stream. Unacknowledged outbox entries
remain. Force stop never ACKs an uncommitted inbound entry.

Restart restores the same `storage_scope_id`, outbox/inbox, pins, mappings,
direction/share epochs, and hash checkpoints before reconnecting. Old socket ACKs fail the
new connection-epoch fence. Config reload drains or explicitly disposes an old
share revision; deleting a share cannot erase ledgers or release pins without
an audited exact-range disposition. Restore from an old backup requires hash
chain reconciliation before either direction resumes.

## 10. Research and promotion plan

The `network_levelupper` track first uses a protocol simulator and hostile peer,
then two local peers, bidirectional restart/resume, and a three-peer loop. It
must measure queue bounds, network/storage cost, media throughput, head-of-line
blocking, and cross-platform behavior before shadow export or canary import.

Absolute-zero gates are unauthorized import, executable remote Action, secret
or key disclosure, accepted corrupt Asset, ACK without local entry, stale
connection commit/ACK, unbounded queue/decompression, and non-terminating loop.

## 11. Conformance vectors

Tests MUST cover lost ACK retransmission with one local ingress; crash at every
outbound/inbound state; Asset range resume and final digest; forged peer/share/
source label; forged Core identity and Action; Asset isolation across security
domains; out-of-order/gapped sequence; checkpoint hash mismatch; stale backup;
two-node and triangle loops; outbox disk full; hostile JSON/slow peer/bombs;
MIME spoof; peer revocation; listener conflict; share-revision reload; distinct
equal-content occurrences; remote deletion; graceful/forced stop; and
restart from every checkpoint.

The suite also runs two Modules with the same `share_id`, peer, and physical
database but different Host storage-scope tuples; neither can observe or ACK
the other's entry, advance its chain, release its pin, or use its broker
handle. A wrong-scope restore, operation status, or background callback fails
closed.
