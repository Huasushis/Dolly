# NapCatQQ Channel Profile

Status: **normative optional profile of the `org.dolly.channel` Extension**.
Dolly v1 does not require NapCatQQ or QQ support. A package claiming this
profile MUST satisfy both the Channel specification and this chapter. A claiming
package uses `hosting: per_extension`; `per_module` placement is not conforming
because the hub/facade broker and their ordered shutdown form one placement
cohort.

NapCatQQ is a user-operated external service. Dolly wraps its OneBot-compatible
network interface; it MUST NOT embed, modify, or redistribute NapCatQQ code or
binaries without separate authorization. The profile has two Module types in
the single `org.dolly.channel` Extension: `napcat-onebot-v11-hub` owns one QQ
account connection and journal, while `napcat-onebot-v11-facade` exposes one
trusted consumer's actions and private results. This preserves Core's single
Action-prefix owner rule. The two Module types retain distinct
`storage_scope_id` values even though one Extension process hosts them.

`REQ-NAPCAT-001` — A conforming profile MUST journal authorized upstream events
before acknowledging them locally, publish only content-free coalesced wakeup
hints by default, and expose content and uncommon capabilities through explicit
pull/catalog Actions rather than mutable Premise or one Block per event.

`REQ-NAPCAT-002` — “Full QQ support” means discoverable coverage of every safe
operation in one pinned, probed NapCat compatibility registry. It does not
claim events or APIs absent from that upstream profile and does not expose
credentials, raw packet injection, account-process control, or a higher
side-effect class to an ordinary Module.

`REQ-NAPCAT-003` — Every consumer view, read cursor, notification
acknowledgement, result, and policy decision MUST be bound to one Host-attested
consumer principal. A caller-supplied Module ID or `storage_scope_id` is not
identity. One consumer cannot observe or consume another consumer's mailbox
state, and reading Dolly state MUST NOT implicitly mark a QQ conversation read.

`REQ-NAPCAT-004` — Sending, upload, moderation, and management are external
effects. The Extension MUST persist dispatch intent, represent a lost response
as `unknown` unless authoritative reconciliation exists, and MUST NOT blindly
repeat an unknown effect.

`REQ-NAPCAT-005` — One Dolly daemon MUST have at most one live hub owner for a
Host account principal and the authenticated, actually probed QQ `self_id`.
Aliases, Extension processes, Module scopes, endpoints, or expected IDs MUST
NOT create a second owner. Cross-daemon active-write ownership is unsupported
in v1.

`REQ-NAPCAT-006` — The facade MUST advertise the fixed ActionContracts in this
chapter, use the fixed argument/result semantic validators, request
`fenced_replay` with the fixed Activation-ledger contract, and prove that the
complete output Block and attached Assets fit frozen aggregate limits before
any external effect. A Host claiming this profile MUST also install
`org.dolly.validator.napcatqq-profile-admission` revision `1`; per-Action
validators MUST NOT be credited with whole-Block, sibling-Part, graph, or
authoritative-Asset checks outside their Core validation context.

## 1. Compatibility registry and canonical operation keys

NapCat documents HTTP calls and event posts, forward WebSocket, and reverse
WebSocket. Its API and event compatibility tables, message-segment guide, file
guide, security warning, exact source revision, and probed runtime identity
form the profile evidence:

- <https://napneko.github.io/develop/api>
- <https://napneko.github.io/onebot/api>
- <https://napneko.github.io/develop/event>
- <https://napneko.github.io/develop/msg>
- <https://napneko.github.io/develop/file>
- <https://napneko.github.io/other/security>
- <https://github.com/NapNeko/NapCatQQ>

### 1.1 Prior-art boundary

The following community projects are useful implementation references for
NapCat/OneBot API coverage, message normalization, reconnect behavior, and QQ
interaction ergonomics. Listing them is not an endorsement, dependency, or
compatibility claim:

- <https://github.com/shubyi/hermes-napcat>
- <https://github.com/JulesLiu390/Amadeus-QQ-MCP>
- <https://github.com/mouse114514/Xadeus-QQ-MCP>

Dolly does not copy their integration boundary. In particular, it does not
inject the complete QQ tool-schema set into every LLM request and does not let
an MCP server own the QQ account principal, connection-owner epoch, durable
journal, consumer cursors, effect ledger, or lifecycle. Those responsibilities
remain in the Extension hub. Facades expose a fixed, bounded Action surface;
mailbox and catalog detail is pulled on demand through private Pages. An MCP
adapter MAY be used behind an independently reviewed package implementation,
but it cannot replace the Host/Extension ownership, fencing, storage, policy,
and recovery contracts in this profile.

Upstream drift is expected. The Extension MUST pin a registry digest containing
the exact supported upstream names, canonical operation keys, argument/result
schemas, output sanitizer digest, side-effect families, message segments,
event types, NapCat/OneBot profile, and source/probe evidence. An unknown
version or digest mismatch enters `NeedsOperator` or a read-only degraded mode;
it MUST NOT invoke an operation under a nearby schema.

Model-visible Actions use only `OperationKey`, the lower-kebab identifier in
`schemas/napcatqq-action.schema.json`. The registry binds each key to one exact
UTF-8 upstream name. For example, a pinned manifest may bind
`group-message-history` to `get_group_msg_history` and
`send-group-message-async-v2` to an upstream name such as
`send_group_msg_async.v2`. The compiler MUST NOT obtain authority by applying a
lossy case/punctuation rewrite at invocation time. Duplicate keys, duplicate
upstream names, ambiguous aliases, or a changed binding fail registry
construction. An invoke contains the key and registry digest; the Extension
looks up the exact upstream name. Raw upstream names are never accepted from a
Page and are omitted from model-facing catalog results; an
`upstream_binding_digest` supplies audit evidence. Deny policy is expressed in
canonical keys.

OneBot events provide no universal durable event ID, cursor, or replay token.
The Extension therefore MUST NOT claim lossless delivery across a NapCat/QQ
disconnect. It records explicit gaps and uses bounded history/contact
reconciliation only where the pinned profile supports it.

All QQ, message, user, group, file, request, and self IDs are normalized as
strings. They MUST NOT pass through a JavaScript-number representation that can
lose precision.

## 2. Hub, facade, Pages, and bounded Premise

Core output Pages broadcast, so one result-producing Module cannot safely
serve mutually distrusting consumers. The conforming topology is:

```text
NapCat forward WebSocket/HTTP
          |
          v
shared hub Module -- private typed broker --+--> consumer A facade
                                             |      | result output
                                             |      v
                                             |   A-private result Page --> A only
                                             |      + Host-ingress content-free hint
                                             |        to A-private notification Page
                                             +--> consumer B facade
                                                    | result output
                                                    v
                                                 B-private result Page --> B only
                                                    + Host-ingress content-free hint
                                                      to B-private notification Page
```

The hub owns the authenticated transport, compatibility registry, account
journal, media-import ledger, notification intents, and outbound-effect
ledger. Each facade owns only its Activation ledger, local view identifiers,
and the binding to exactly one trusted consumer principal
`(instance_id,module_id)`. The principal comes from the Runtime-derived Block
producer and configured graph identity; it is never read from Action
arguments, metadata, a caller claim, or a source storage scope.

The `napcat-onebot-v11-hub` Module type MUST bind the whole root
`schemas/napcatqq-hub-config.schema.json`; the
`napcat-onebot-v11-facade` type MUST bind the whole root
`schemas/napcatqq-facade-config.schema.json`. The union resource
`napcatqq-config.schema.json` is only the shared definition/catalog resource and
MUST NOT be used as either Module type's ConfigSchemaBinding. Config bindings
deliberately have no fragment selector, so a valid facade configuration must
never be admitted for a hub Module or vice versa.

Configuration preparation MUST prove all of the following:

1. a facade names one existing hub with the same Host account principal and
   account reference;
2. its only Module output Page is `private_result_page_id` and every subscriber
   to that Page is in the one configured consumer-principal authorization
   cohort;
3. only that principal can consume `private_notification_page_id`, and the hub
   has Host-ingress authority for exactly the facade's configured result and
   notification Pages: content-free hints may target only the latter and media
   delivery Blocks may target only the former;
4. no result or notification Page is shared with another principal;
5. the hub and facade have the same Extension alias and `per_extension`
   placement cohort, the configured `hub_module_id` resolves to the hub type,
   their account reference and Host account principal are identical, and their
   stable `storage_scope_id` values are distinct; and
6. the hub has no ordinary output Page; all background publication uses the
   exact Host-ingress grants above. A graph that cannot prove these facts is
   rejected, not degraded to best effort.

These are Host control-plane facts, not JSON configuration fields. The Host
selects the fixed NapCatQQ control/profile validator from the verified Module
type; a `$comment` in a configuration schema is not a validator binding. It
receives the immutable candidate graph/configuration, Module-type and
Extension-manifest records, principal/subscriber cohorts, exact output Pages,
exact ingress grants, placement cohort, and scope identities. Configuration
commit is rejected if any fact is absent rather than asking the Extension to
attest it.

The hub/facade interface is a versioned package-internal typed service bound to
the Host-frozen hub Module identity, facade Module identity, Extension process
generation, and consumer principal. It is not a Dolly Module-to-Module RPC.
Facades MUST NOT open the hub database, derive its path, or issue unscoped SQL.
The hub performs every read/write on its own Host-managed storage scope and
partitions consumer state by the attested principal. Multiple facades may share
the one hub without sharing result Blocks, cursors, views, or authorization.
If an implementation uses one physical database for the cohort, every semantic
key/foreign key/transaction is still led by the owning Module's
`storage_scope_id`; this is a storage implementation, not a shared writable
namespace. Only an explicit Core shared-state contract could relax that rule,
and this profile defines none.

The broker exists only inside the one `per_extension` process generation. Its
method dispatcher re-authenticates the facade's Host-bound Module context on
every call; a caller-supplied `module_id`, principal, Page, or scope is only a
consistency check. A profile implementation MUST NOT emulate this broker by
opening a second Module's state path, by an ambient localhost port, or by an
unregistered cross-process RPC.

The Descriptor Premise projection is static and bounded. It MAY say this is a
queryable QQ mailbox, that a wakeup hint contains no mailbox detail, and that
actions are policy-controlled. It MUST NOT contain live messages, friend/group
lists, unread counts, current conversation, credentials, the full operation
registry, or one description per upstream API. Neither `descriptor.changed`
nor Extension progress notifications may transport QQ content.

### 2.1 Host-owned profile/block admission boundary

`org.dolly.validator.napcatqq-profile-admission` revision `1` is a pure,
bounded, Host-owned profile validator with three entry points. It is stricter
admission around the ordinary Core transactions; it does not repair a Block,
grant authority, call the Extension, or replace Core validation:

1. **input Action-set admission**, before committing a Block targeting a
   facade, receives the complete candidate Block, frozen target graph/module
   record, selected fixed ActionContracts, and the facade's frozen output
   limits. It checks the aggregate targeted Action count, declared read/media
   maxima, worst-case one-result-per-Action reserve, and possible media-delivery
   count/bytes;
2. **facade output admission**, before staging an Activation result, receives
   the complete candidate BlockDraft, frozen Manifest, ordered applicable
   Actions, effective config/limits, and canonical byte count. It requires
   exactly one ordered common ActionResult JSON Part for every applicable Action,
   no facade-produced Asset Part, no output Action, and no unbudgeted
   description, metadata, hints, or extra Part; and
3. **hub ingress admission**, before `host.ingress.submit`, receives the complete
   candidate BlockDraft, authenticated hub Module, exact ingress grant/Page,
   operation/notification ledger record, limits, and authoritative Asset
   metadata when applicable. A mailbox hint is exactly one fixed JSON Part and
   nothing else. A media delivery is exactly one typed delivery-envelope JSON
   Part followed by one ordinary Core Asset Part whose ID, detected media type,
   BLAKE3 hash, and byte length equal the authoritative Asset record.

The input entry point is the only profile validator allowed to reason about a
*set* of Actions. The output and ingress entry points are the only ones allowed
to reason about sibling Parts or a complete Block's canonical bytes. Ordinary
Action argument/result validators retain exactly the narrower Core context. All
three entry points run before the corresponding Core commit; a profile failure
rejects that whole candidate transaction.

## 3. Fixed progressive capability surface

The facade Descriptor has the following fixed ActionContracts. `args` and
`result` are URI fragments beneath the named schema resource; every schema
binding carries the verified transitive bundle digest.

| Action | args | successful result | side-effect class | semantic validators |
| --- | --- | --- | --- | --- |
| `org.dolly.channel.send` | `channel-send.schema.json` | `channel-send-result.schema.json` | `non_idempotent_write` | base Channel bindings |
| `org.dolly.channel.qq.mailbox` | `napcatqq-action.schema.json#/$defs/MailboxArgs` | `napcatqq-result.schema.json#/$defs/MailboxResult` | `idempotent_write` | `napcatqq-action@1` / `napcatqq-action-result@1` |
| `org.dolly.channel.qq.conversation` | `#/$defs/ConversationArgs` | `#/$defs/ConversationResult` | `idempotent_write` | same |
| `org.dolly.channel.qq.send` | `#/$defs/QqSendArgs` | `#/$defs/SendResult` | `non_idempotent_write` | same |
| `org.dolly.channel.qq.media` | `#/$defs/MediaArgs` | `#/$defs/MediaResult` | `idempotent_write` | same |
| `org.dolly.channel.qq.message-control` | `#/$defs/MessageControlArgs` | `#/$defs/MessageControlResult` | `non_idempotent_write` | same |
| `org.dolly.channel.qq.catalog` | `#/$defs/CatalogArgs` | `#/$defs/CatalogResult` | `read_only` | same |
| `org.dolly.channel.qq.query.invoke` | `#/$defs/QueryInvokeArgs` | `#/$defs/InvokeResult` | `read_only` | same |
| `org.dolly.channel.qq.mutate.invoke` | `#/$defs/MutateInvokeArgs` | `#/$defs/InvokeResult` | `non_idempotent_write` | same |
| `org.dolly.channel.qq.manage.invoke` | `#/$defs/ManageInvokeArgs` | `#/$defs/InvokeResult` | `non_idempotent_write` | same |
| `org.dolly.channel.qq.files.invoke` | `#/$defs/FilesInvokeArgs` | `#/$defs/InvokeResult` | `non_idempotent_write` | same |

Here `napcatqq-action@1` abbreviates
`org.dolly.validator.napcatqq-action` revision `1`, and the result name
abbreviates `org.dolly.validator.napcatqq-action-result` revision `1`. The root
schema resources carry the identical validator annotations. A Descriptor MUST
NOT substitute a generic JSON schema, omit a validator, point two names at a
different fragment, or change a side-effect class. Dynamic registry entries are
data selected behind the four fixed invoke contracts; they are not dynamic
ActionContracts.

The pure argument validator checks one Action's selected fragment discriminator,
canonical operation key, registry/sanitizer digests, view-reference shape, and
per-Action frozen effective limits. An installed package binds its immutable,
verified, digest-indexed registry/sanitizer table as a retained package resource;
it MUST NOT perform transport or mutable state I/O. Runtime dispatch still
performs current authorization and exact registry argument validation
immediately before an effect. The pure result validator checks Action/result
identity, operation/family/digest equality, cursor and ordinal ordering,
requested per-Action limits, and the closed sanitized-value algebra. It receives
no sibling Action, Part, graph, complete Block, or mutable hub state and MUST NOT
claim to validate those relations; section 2.1 owns them. It neither repairs a
result nor establishes that an upstream effect occurred.

The base `org.dolly.channel.send` remains required by the Channel profile and
accepts only an immutable account-scoped session ID. It never interprets a
facade view. `org.dolly.channel.qq.send` is the QQ-specific stateful surface: a
view selector always contains `(view_id,expected_view_epoch)`, while an explicit
conversation selector avoids view state. A stale epoch fails before upload or
send, preventing a previously opened group from being silently retargeted.

`catalog.search` returns bounded summaries and `catalog.get` returns one exact
pinned schema on demand. An invoke names the registry digest, canonical
operation key, sanitizer digest, family, arguments, and optional selector.
Async upstream aliases are not separate model-visible operations. APIs that
return credentials, cookies, client keys, raw packets, or account-process
control are admin-local or forbidden and cannot become safe merely because
their names are hidden from Premise.

## 4. Connection, endpoint, and daemon-wide ownership

The durable hub state machine is:

```text
Stopped -> ReservingOwner -> Connecting -> Authenticating -> Syncing -> Ready
Ready -> Degraded -> Reconnecting -> Syncing
ReservingOwner/Connecting/Authenticating/Syncing -> NeedsOperator
any running state -> Draining -> Stopped
```

The resolved `host_account_principal` is a Host-issued, immutable identity for
the credential-bound upstream account. User text, `account_ref`, endpoint, and
`expected_self_id` do not create that principal. Before opening a transport,
the Host reserves this principal in one daemon-wide owner registry spanning all
Extension processes and Module scopes. After authentication, the hub probes the
actual `self_id`, verifies it equals `expected_self_id`, and atomically binds
the reservation to `(host_account_principal,actual_self_id,owner_epoch)`. A
mismatch disconnects and enters `NeedsOperator`. A second live reservation for
the principal, the actual `self_id`, or resulting pair is rejected even when its
endpoint, credential/account alias, expected ID, storage scope, or Extension
process differs. The daemon registry therefore has separate unique live indexes
on `host_account_principal` and `actual_self_id` in addition to its composite
audit key. Principal reservation happens before transport; the actual-self-ID
claim happens atomically after authentication and before the connection becomes
event/effect eligible. Two credential records that authenticate as the same QQ
account cannot evade the latter claim.

`Ready` requires the live owner epoch, authenticated transport, probed expected
`self_id`, accepted version profile, health probe, loaded registry digest, and
completed bounded reconciliation or explicit gap. Heartbeat alone is not
readiness evidence. Every journal, notification, media, and effect write names
the current owner epoch; stale sockets and replaced generations fail closed.

Hot replacement is a single-owner handoff. The candidate may parse config and
load the registry but MUST NOT authenticate concurrently. The old owner fences
new work, drains, closes its socket, persists state, and releases its epoch;
only then may the Host grant a new reservation. Crash recovery first fences the
old process generation and socket before granting a new epoch.

The initial transport is one authenticated forward WebSocket event source plus
HTTP action calls where required by the pinned registry. Concurrent HTTP event
posting and WebSocket event ingestion are forbidden without a separately
versioned cross-transport dedup profile. v1 provides no cross-daemon active
write protocol. An external lease field is not accepted by the config schema
and does not make two daemons conforming writers. A separately operated
read-only observer may exist only under an upstream-supported profile, but it
does not advertise cross-daemon ownership or cursor isolation.

Endpoints are parsed as URIs, not accepted by prefix matching. The fixed config
validator rejects userinfo, password, query, fragment, control characters,
ambiguous/encoded authority, unsupported schemes, and missing ports where the
chosen transport requires one. With `allow_non_loopback=false`, the parsed host
must be a literal loopback address; a hostname such as `localhost` is rejected
to avoid resolver/rebinding ambiguity. The raw authority must spell exactly
`127.0.0.1:<port>` or `[::1]:<port>`; WHATWG-normalized alternatives such as
`127.1`, integer/hex/octal IPv4, IPv4-mapped IPv6, percent-encoded authority,
backslashes, and trailing-dot hostnames are not accepted as equivalent literals.
With it true, non-loopback HTTP uses
`https` and WebSocket uses `wss`, and an elevated Host network policy must
authorize the canonical resolved addresses. Redirects are disabled. Logs and
diagnostics record a redacted origin/path class, never userinfo, credentials,
tokens, query strings, cookies, or signed URLs.

## 5. Journal, eviction, views, and content-free hints

Hub/facade durable state includes at least:

```text
AccountState(host_account_principal, actual_self_id, owner_epoch,
             connection_epoch, registry_digest)
JournalEvent(local_event_seq, connection_epoch, normalized_event,
             normalized_bytes, payload_digest)
RetentionGap(gap_id, from_cursor, to_cursor, reason, certainty)
ConsumerRegistration(consumer_principal, facade_module_id, notification_page)
ConsumerView(consumer_principal, view_id, conversation_ref, view_epoch,
             read_cursor, notification_ack_cursor)
NotificationIntent(consumer_principal, coalesce_slot, ingress_key, state)
HubOperationLedger(consumer_principal, action_id, semantic_digest, operation_family,
                   snapshot_boundary, local_mutation, canonical_result,
                   disposition, facade_activation_id, retention_state)
OutboundEffectLedger(consumer_principal, action_id, semantic_digest,
                     effect_stage, upstream_ids, disposition)
MediaImportLedger(consumer_principal, action_id, semantic_digest, media_handle,
                  import_id, delivery_ingress_id, asset_id, disposition)
```

An observed event is authenticated, bounded, normalized, and appended before
any wakeup is eligible:

```text
Observed -> Journaled -> MediaPending/MediaAvailable -> Indexed
         -> HintPrepared -> HintSubmitted
```

The private journal is authoritative. `host.ingress.submit` sends the fixed
payload in `schemas/napcatqq-mailbox-changed.schema.json` to the consumer's
private notification Page. That payload contains only `schema` and `kind`: no
account, cursor, counts, event class, conversation, sender, message, gap,
overflow, or media state. Its stable ingress idempotency key and debounce slot
are private ledger fields, not payload. Multiple changes coalesce into one
outstanding hint; a lost response is reconciled with `host.ingress.status`.
The notification Page MAY be lossy because a pull reads the journal.

The hub-ingress profile validator closes the *entire* hint BlockDraft, not only
the JSON value: `parts` contains exactly one JSON Part with schema URI
`napcatqq-mailbox-changed.schema.json`, `actions` is empty, and `description`,
`metadata`, `hints`, and every extra Part are absent. Thus an Extension cannot
append message text or an Asset while still presenting a schema-valid hint.

Journal capacity is enforced by both complete canonical normalized-event bytes
and event count. Before an append would cross either frozen limit, one
transaction evicts the smallest complete oldest prefix that restores
headroom, advances `oldest_available_cursor`, writes a `RetentionGap` covering
the exact evicted range, and marks every affected consumer as gap-pending.
Consumer read/ack cursors are not silently rewritten. A later read whose
requested cursor predates the floor returns the gap and starts from the floor.
Adjacent acknowledged gaps may be coalesced; an unacknowledged gap needed by a
registered consumer MUST NOT be discarded merely to hide eviction.

An event larger than `max_normalized_event_bytes` becomes one bounded
`oversized_event` gap/marker containing only classification and payload digest;
raw bytes, paths, URLs, and cookies are discarded after required private
diagnostics. If even a marker cannot be committed because storage is full, the
hub stops acknowledging/reading upstream, disconnects, and records a
`disk_full` possible-loss gap on recovery. It MUST NOT emit a hint for an
unjournaled event. Media bytes, unresolved outbound effects, and Activation
ledgers do not count as evictable journal entries and have separate retention
and disposition rules.

Message IDs deduplicate message events within the account. Request flags and
notice-specific identities are used where defined. For an event with no stable
identity, a complete raw-payload digest may suppress immediate transport
duplication only inside a short recorded window. Sender plus content hash is
insufficient: two consecutive identical messages are two legitimate events.

`mailbox.read` is bounded by event count, total canonical result bytes, and the
facade output budget. It returns ordered events, `next_cursor`, `has_more`,
`oldest_available_cursor`, and all relevant bounded gaps. Every view belongs to
the attested consumer principal. `conversation.open` creates or changes only a
local view and increments `view_epoch`; local mailbox `ack` and upstream QQ
`mark_read` remain distinct actions.

Every typed-broker call, including `peek/read/stats/ack`, conversation
list/open/close/history/search, catalog/query, media acquisition, and each
effect family, is first accepted into `HubOperationLedger` under
`(consumer_principal,action_id,semantic_digest)`. A read operation freezes its
journal upper boundary and policy/registry revisions; a local mutation records
the exact prior/after cursor or view epoch in the same transaction. The hub
persists the exact canonical result or failed/unknown disposition before making
the broker response facade-visible. Repeating the tuple returns that result
byte-for-byte. Reusing an Action ID with another semantic digest is a permanent
conflict.

`OutboundEffectLedger` and `MediaImportLedger` are subordinate stages of that
general operation record, not substitutes for it. A hub operation record and
its result cannot be evicted until the facade Activation is terminal and the
profile's replay/audit retention has elapsed. Journal retention eviction never
deletes operation, import, notification, or effect-ledger authority.

## 6. Authorization and trusted caller identity

Resolved hub and facade configurations conform to their role-specific roots
named in section 2; the shared `schemas/napcatqq-config.schema.json` union is not
a Module binding.
Authorization is the intersection of account policy, exact attested consumer
principal, operation family, resolved conversation and sender/event scope,
media policy, quotas, and the frozen configuration revision. Explicit deny
wins over explicit allow, which wins over the account default.

On every applicable Action, the facade verifies that the containing Block's
Runtime-derived producer exactly equals its configured consumer principal. It
rejects external/runtime producers, forwarding Modules, a matching Module ID
under another instance, and arguments or metadata claiming the trusted ID.
The hub independently verifies the facade identity, principal binding,
generation, and action semantic digest on its typed broker call.

A rule such as “do not speak in group X” is re-evaluated immediately before
every effect after resolving the real target. It applies equally to the base
send, QQ-specific send, generic mutation, media/file APIs, message control, and
management APIs. It cannot be bypassed through catalog invocation, a stale
view, a prompt instruction, or a configuration change between prepare and
dispatch. Search/list operations filter unauthorized records before ranking,
counts, pagination, and summaries so they do not leak existence.

## 7. Multimodal and sanitization boundary

Mailbox results MUST NOT embed `common.Part`, arbitrary OneBot JSON, local
paths, temporary/signed URLs, cookies, or upstream upload handles. A
`MailboxEvent` contains only the closed `MailboxSegment` union in
`napcatqq-result.schema.json`. Text and identifiers remain untrusted external
content. Media is represented by a bounded `media_ref` with an opaque
account/principal-scoped `media_handle`, classification, state, size/type hints,
and optional expiry time—never the acquisition URI.

The independent `org.dolly.channel.qq.media` Action resolves one authorized
handle. The hub imports or derives the bytes under the hub Module's own
`host.assets.import` authority and, after `AVAILABLE`, submits one idempotent
private media-delivery ingress Block to that consumer facade's
`private_result_page_id`. Because the authenticated importing hub is also the
ingress producer, no Asset authority is transferred to the facade and the
facade never attempts to output a hub-owned Asset.

The media-delivery Block contains exactly two Parts in order: a JSON
`MediaDeliveryEnvelope` from `napcatqq-result.schema.json`, then one ordinary
Core Asset Part. The ingress profile validator checks its exact target Page,
`delivery_ingress_id`, Action/media handle, Asset ID, detected media type,
authoritative byte length, and Asset Service BLAKE3-256 content hash. The
facade's ordinary successful `MediaResult` contains the same stable ingress ID
and Asset metadata for correlation but has no sibling-Part index. A lost ingress
response is reconciled through `host.ingress.status`; repeating the Action uses
the same import and ingress IDs. Lazy media may expire and returns a normal
failed ActionResult without an ingress Block or fabricated Asset.

Silk conversion or thumbnail/transcode work creates a derived Asset with
provenance and finite CPU, memory, byte, pixel, and duration limits. Recursive
forward expansion is pull-only and bounded by depth, messages, Assets, and
bytes. Outbound `org.dolly.channel.qq.send` media uses the ordinary Core
`common.Part` text/asset union, not a QQ-owned `asset_ref` JSON copy. Therefore
Core reachability, detected-media-type, safe-view, and short-lease checks apply
before dispatch. Upload and message send remain distinct ledger stages;
rebuilding an expired upload never authorizes resending a message whose outcome
may already be applied.

Every registry entry names a fixed sanitizer digest. Before any catalog or
invoke result enters a Block, the pinned normalizer removes credential-bearing
URIs, userinfo, query/fragment secrets, cookies, tokens, local/UNC paths, raw
packet fields, process-control fields, and unbounded/recursive data; media is
converted to `media_handle`. Result field names and strings are bounded and
Unicode/control-character policy is deterministic. Invoke results contain
`sanitized_value` and the sanitizer digest. The result validator requires that
digest to equal the frozen Action and immutable registry entry, validates the
operation-specific pinned result schema, reruns the exact pinned normalizer, and
requires a fixed point in the closed `SanitizedValue` algebra. That algebra has
bounded depth/nodes/JCS bytes, bounded lowercase field names, and no credential,
authorization, cookie/token/secret, raw path/URI, raw packet, or process-control
field. An arbitrary JSON object plus a copied digest is invalid. Sanitization is
not authorization: unauthorized records are removed before counts and
pagination, and prompt-injected strings remain external content.

## 8. Aggregate output budget and replay/effect ledgers

Facade configuration freezes `max_actions_per_activation`,
`max_output_block_bytes`, `max_read_events`, `max_read_bytes`,
`max_top_level_parts`, `max_attached_assets`, and
`max_attached_asset_bytes`. Configuration preparation MUST also bind Core
batching so a facade Manifest contains at most one input Block, and prove the
worst-case ActionResult envelope reserve plus private media-delivery ingress
budget fits Core's Block/Part/frame limits. At Block commit, the section 2.1
input Action-set admission validator—not a per-Action argument validator—rejects
a targeted Action set whose count, sum of declared read/media byte maxima,
fixed one-result-per-Action error reserve, or possible media-delivery count
exceeds those limits.

At Activation start the facade recomputes the exact reservation from the frozen
Manifest and effective config before calling the hub. It then tracks canonical
bytes for the complete facade output Block body—not only business payload—and
the separately authorized media-delivery count/bytes. Bounded
pagination/truncation decisions are
deterministic and declared by the result schema. If a valid complete set of
required ActionResults cannot fit, the Activation fails safely before any
effect; it MUST NOT dispatch some Actions and then omit their results. A
sanitizer or upstream response cannot expand past the reservation.

Every facade Descriptor requests exactly:

```json
{
  "mode": "fenced_replay",
  "evidence": "activation_ledger",
  "ledger": {
    "namespace": "org.dolly.channel.napcatqq.facade-activation",
    "schema_version": "v1",
    "location": "module_state_directory"
  }
}
```

The facade ledger is keyed by `(activation_id,manifest_digest)` and records the
frozen config/contract digests, ordered Action IDs and semantic digests, output
reservation, intent phase, hub operation IDs, canonical successful results or
failed/unknown dispositions, and final result digest. It fsyncs prepared intent
before any broker call. On same-Activation replay it returns the byte-identical
result when complete or reconciles recorded operations; it never constructs a
new Action ID or treats a missing/corrupt ledger as evidence.

The hub's general operation ledger is keyed by
`(consumer_principal,action_id,semantic_digest)`; outbound effects and media
imports are subordinate records under the same accepted operation. The safe
ordering for an external effect is:

```text
facade Activation intent durable
    -> hub operation accepted, snapshot/mutation identity durable
    -> hub Dispatched durable before bytes become upstream-eligible
    -> authoritative response/reconciliation durable
    -> facade result and Activation evidence durable
```

There is no claimed cross-database atomic transaction. A crash between steps is
resolved by replaying the same tuple: the hub returns its prior disposition or
continues reconciliation. `Prepared` with no hub operation is safe to start;
`Dispatched` with no authoritative response becomes `Unknown`. Activation-ledger
authority permits reconciliation or return of a prior result, never blind
redispatch of an unknown QQ effect.

For a read or local mutation there is no `Dispatched` external-effect phase:
acceptance freezes the read boundary or commits the cursor/view mutation and
canonical result in one hub transaction before reply. Thus a crash after hub
acceptance but before facade evidence cannot produce a newer read page, another
view ID, or a second acknowledgement on replay.

External effects move through:

```text
Prepared -> Dispatched -> Confirmed
                       -> FailedNotApplied
                       -> Partial
                       -> Unknown
```

A matching self event suppresses an echo only when its authoritative identity
matches the outbound-effect ledger. A user manually sending from the same QQ account
remains a real inbound event. Similar target/time/content is diagnostic, not
authoritative reconciliation.

## 9. Stop, restart, reload, and isolation

A facade `module.shutdown` fences only that facade, unregisters only its typed
broker endpoint/principal after its Activation ledger is terminal or explicitly
dispositioned, and leaves the hub, transport, owner epoch, and other facades
running. It MUST NOT close the shared socket or release account ownership.

A hub `module.shutdown` is accepted only after every attached facade is
Quiesced/Stopped and its broker calls are drained. Planned shutdown of the
`per_extension` cohort therefore orders facade quiesce/shutdown receipts first,
then hub shutdown. The hub fences new Actions and hint/media ingress creation,
fsyncs the journal/gaps/general-operation/media/effect ledgers, marks unresolved
dispatched effects unknown, closes the transport, and releases the daemon owner
epoch last. `extension.shutdown` follows the ordinary common protocol only after
those Module receipts. It disconnects Dolly's wrapper; it does not stop the
user-owned NapCat/QQ process.

Force-stop or process death fences the Extension generation and owner epoch.
Restart restores the hub and each facade from their own unchanged
`storage_scope_id` before reconnecting. It verifies database tenant/scope
metadata, registry and sanitizer revisions, consumer-principal bindings,
private Page/ingress bindings, gaps, views, notification intents, general hub
operations, media deliveries, and unresolved outcomes. A facade never discovers
or opens hub state by path; the restored
typed broker reattaches only after the Host proves both identities. Missing,
foreign, corrupt, or downgraded Activation-ledger state prevents fenced replay.

Hot reload uses the common snapshot protocol and the single-owner handoff. It
cannot reset unread cursors, erase retention gaps, reinterpret old Actions under
a new operation mapping/sanitizer/policy, or upgrade replay authority. A new
registry remains inactive until old Actions are completed, retained under a
compatible generation, or given an audited disposition.

## 10. Conformance tests

Tests MUST cover at least:

- daemon-wide duplicate owners across credential/account aliases, Host
  principals, actual self IDs, endpoints, storage scopes, and Extension
  processes; probed/expected self mismatch; handoff and stale owner epochs; and
  explicit rejection of cross-daemon active write;
- two facades sharing one hub while results, hints, cursors, views, and policies
  remain private; forged principal fields; forwarded Actions; subscriber graph
  changes; and restoration under the original scopes;
- proof that the complete coalesced-hint BlockDraft has exactly one fixed JSON
  Part, no extra Part/Action/description/metadata/hints, and that live traffic
  never mutates Premise or creates event-by-event Extension notifications;
- 100,000-event storms, exact count/byte eviction, slow consumers, gap
  coalescing/acknowledgement, oversized events, disk full, disconnect gaps, and
  bounded supported backfill;
- exact duplicate legitimate messages, reconnect duplicates, sent echoes, and
  missing upstream replay identity;
- QQ-specific explicit/view sends, stale view epochs, base immutable-session
  sends, deny policy through every effect surface, and policy/registry races;
- registry keys mapped to uppercase, punctuation, underscore, dot, and Unicode
  upstream names; collision rejection; exact mapping invocation; and registry
  drift;
- URI userinfo/query/fragment/encoded authority, alternate integer/hex/octal or
  shortened loopback spellings, loopback rebinding,
  redirects, non-TLS remote endpoints, prompt injection, cookies/tokens, local
  and UNC paths, recursive/unbounded JSON, and sanitizer-digest mismatch;
- media handles, hub-owned private media-delivery ingress, exact two-Part
  envelope/Core-Asset shape, authoritative BLAKE3 hash/length/MIME, temporary
  URL expiry, MIME spoofing, Silk failure, oversized media, recursive forwards,
  interrupted upload, and missing/duplicate chunks/hashes;
- every facade Activation-ledger and general hub-operation/effect/import-ledger
  crash point, including read/view/local-mutation result loss, prepared,
  accepted, dispatched, response-lost, result-lost, partial, unknown,
  corrupt/missing replay evidence, facade-only stop, ordered cohort stop,
  restart, and hot replacement; and
- aggregate output accounting for many Actions/results, JSON escaping and UTF-8
  expansion, maximum top-level Parts, Asset count/bytes, pagination, and proof
  that no external effect occurs before the complete output reservation fits.
