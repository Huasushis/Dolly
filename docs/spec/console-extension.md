# Dolly External Console Extension

Status: Draft

`Console` is a working name for Dolly's external ingress and egress experience.
This document does not select a final product name. A later rename MUST NOT
change protocol identity, authorization, delivery, or retention semantics.

This document proposes the contract for browser and command-line interface
(CLI) clients that submit user messages to Dolly and observe resulting Blocks.
The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119. Because this
document is a Draft, these terms describe the proposed contract and do not
claim current implementation conformance.

## 1. Scope and goals

This specification covers:

- authenticated text and multimodal external ingress;
- conversion of queued external messages into source activation requests;
- bounded deterministic batching into zero or one Block per Module action;
- Page-to-session egress without implicit global history;
- browser and CLI protocol parity;
- session, tenant, route, and Page authorization;
- upload and display through media capabilities;
- acknowledgement, retry, tool, and approval states;
- a responsive, accessible, localized work-focused user interface (UI); and
- deterministic runtime, security, accessibility, and visual acceptance tests.

The Console is an operational surface, not a chat-history authority, memory
system, or privileged prompt source. Durable conversation memory, semantic
indexing, model behavior, and Page retention remain separate concerns.

## 2. Relationship to other contracts

The Console MUST obey:

- `core-runtime.md` for Block, Module job, Module actor, Page, Delivery, Claim,
  acknowledgement, source activation requests, and zero-or-one output semantics;
- `block-payload.md` for ordered text/Media content and the single reference
  source used by the Core;
- `extension-process-protocol.md` for isolation, lifecycle, capabilities, and quotas;
- `media.md` for asset registration, views, browser representations, leases,
  validation, and deletion;
- `security-operations.md` for network exposure, authentication, Origin,
  cross-site request forgery (CSRF), WebSocket, Content Security Policy (CSP),
  secret, logging, and public deployment controls; and
- `llm-extension.md` for any tool or approval state originating in a large
  language model (LLM) flow.

The Console MUST NOT redefine those contracts. In particular, it MUST NOT write
directly to Page storage, choose core Block identity or source fields, bypass a
Module actor, or treat delivery to a browser as a core input acknowledgement.

## 3. Architecture and trust boundaries

The conceptual system contains three roles:

1. A host-owned **Console gateway** terminates Hypertext Transfer Protocol
   (HTTP), WebSocket, or equivalent local transport, authenticates clients,
   validates sessions and routes, streams uploads through media capabilities,
   owns bounded ingress/display stores, and owns the corresponding
   host-subsystem strong references.
2. A **Console ingress source Module** is activated by source activation
   requests from the gateway. One valid non-empty frozen snapshot produces
   exactly one BlockProposal.
3. A **Console egress sink Module** consumes the static input Pages of one route,
   prepares an idempotent host-owned display handoff, and MUST always return no
   BlockProposal.

Ingress and egress are separate Module roles. They MUST NOT be implemented as
an undocumented hybrid activation mode. They MAY be shipped in one package and
MAY use the same host-owned gateway, schemas, and libraries. Under the initial
Extension process protocol, they MUST run in separate Extension process sessions
because one process session has one live Module failure domain. "Shared service"
in this document never means that ingress and egress share an extension process,
actor, generation fence, or Module-private storage namespace.

The current Module result commit coordinator requires a Delivery Claim and
input acknowledgement. Therefore the first runtime supports only the reactive
egress sink role and MUST reject the source/manual ingress Module role. The
source-ingress behavior in Section 5 is a future contract and does not claim an
implemented completion boundary.

The gateway is the only externally reachable component. An extension process
MUST NOT open its own unauthenticated listener or expose the Extension process
protocol to a browser. Browser and command-line clients speak a versioned
external protocol to the
gateway; the gateway invokes runtime and extension capabilities on their behalf.

The gateway's queue and display strong references are owned by persistent host records. They are
not browser-visible AccessLeases, caller-managed retain/release counters, or
Module-owned strong references. A Console Module that independently retains private durable
context MUST use bounded `ModuleRetentionChange` entries from `core-runtime.md`;
it MUST NOT use `ModuleRetentionChange` to impersonate the gateway as owner of a
queued message or display handoff record.

The current reference graph has no Console-specific owner kind, so this gateway
ownership path is not yet available. Before Console is enabled, each upload,
queued-message, and display owner MUST have a concrete versioned persistent
record type, a fixed owner kind, recovery enumeration, and cross-checks against
the gateway store. The reference graph schema must then add those exact kinds.
Implementations MUST NOT construct authority by concatenating client strings or
register a generic namespaced owner kind. Duplicate targets under one concrete
owner remain one idempotent strong reference. Strong-reference mutation is
available only to the trusted gateway state machine and its recovery worker,
never as a generic Extension/client capability.

Client fields, filenames, media metadata, text, locale, Page labels, model
output, and tool descriptions are untrusted. Authentication establishes the
client identity and granted scope; it does not make submitted content trusted.

### 3.1 Durability compatibility

The Console declares one `durability` value, independently visible in
configuration and status:

| Console durability | Required Core durability | Required Media durability | Permitted success claim |
| --- | --- | --- | --- |
| `volatile` | `volatile` or `persistent` | `volatile` or `persistent` | Process lifetime only |
| `persistent` | `persistent` | `persistent` | Restart-safe after commit |

For `volatile`, the UI and protocol MUST NOT call queue or display acceptance
durable or restart-safe. For `persistent`, queue receipts, display handoffs,
strong references, ingress message records, and reconciliation survive restart
before durable success is reported.

An incompatible durability combination MUST fail route activation. A persistent Console MUST NOT run
against volatile Core state or volatile media and then preserve a queue or
display handoff record that refers to state the other subsystem may lose. The gateway
store, Core Module job/outbox state, and media ownership graph need not use one
database, but their display preparation and Module job outcome procedures MUST pass the
same crash/reconciliation tests. Remote/public deployment does not create a
third durability value.

When a volatile Console runs over persistent Core or Media state, every
host-owned Console strong reference and record in `prepared` state MUST carry
the Console gateway process generation identifier. On restart the gateway
terminally classifies the missing volatile work and retires every strong
reference from the abandoned process generation before accepting new work. It
MUST NOT leak persistent strong references or imply that an already-acked volatile display
can be reconstructed.

### 3.2 First-party host capabilities

The host defines separately versioned, non-generic capability types for the two
Module roles:

- an ingress snapshot capability exposes only the immutable snapshot already
  frozen for the current source Module job; and
- a display prepare capability prepares only the exact current Core input and
  the route/member snapshot already bound to the current egress Module job.

Every handle is scoped to `instanceId`, Module instance and generation,
`moduleJobId`, `runId`, route and route revision, allowed operations, byte/count
limits, and expiry. Core guarantees `moduleJobId` is globally unique within one
instance; durable Console records therefore use `(instanceId, moduleJobId)` as
their primary Module job scope. An `idempotencyKey` from a source activation
request, route identifier (ID), session ID, message ID, or Block ID alone is
never a capability.

Ingress snapshot reads are pure and return the same frozen snapshot digest on
every retry. Display preparation uses `moduleJobId` as its idempotency key,
rejects a different input, membership, or expected-result digest for an
existing preparation, and provides a read-only status operation. Preparation
is not publication. The gateway publishes or retires records in `prepared`
state only after the Extension process protocol `module-job-outcome` operation
reports that the exact `moduleJobId` committed with the expected canonical
`resultDigest` and retention changes. A commit notification is only a wake-up
optimization; missing notifications MUST be recovered by outcome lookup.

## 4. Identity and routing

### 4.1 Required identities

Every accepted operation MUST be bound server-side to:

- Dolly `instanceId`;
- `tenantId` or single-owner scope;
- authenticated principal and `sessionId`;
- Console gateway and Module instance identities;
- a stable route ID; and
- request, operation, and client idempotency IDs where applicable.

These identities are opaque and MUST NOT be inferred from display names,
filenames, Uniform Resource Locators (URLs), browser tabs, or user-supplied
payload fields. A client-provided tenant, session, Page, source, or actor
identifier is a lookup hint at most; the gateway MUST replace or validate it
against authenticated server state.

### 4.2 Route bindings

A route is a host-owned, revisioned authorization and topology object. One
route revision binds:

- an allowed tenant/audience;
- exactly one Console ingress source Module instance and one non-empty static
  output Page set;
- exactly one Console egress sink Module instance and one non-empty static input
  Page set;
- whether the route is private to one session or shared inside a tenant;
- the Core consumer start policy, per-session display start/offline-retention
  policy, and close/cancellation policy; and
- media, tool, upload, rate, and display capabilities.

Each Console Module instance is bound to exactly one route revision. Its input or
output Pages cannot be selected by a client, source activation request, message,
Module result, or display member. Changing either Page set creates a new route
revision with new ingress and egress Module instance IDs. The old revision
retains its original instances and Page configuration until every
accepted/frozen Module job is
committed or reaches an explicit terminal disposition and its consumer is
retired. Advancing only `moduleGenerationId` while reusing one Module instance
for another Page topology is forbidden. Accepted work MUST NOT be redirected to
the new Page set. A route MUST NOT reuse a Module instance across tenants, route
revisions, or different Page sets.

The client selects an authorized route alias. It MUST NOT submit arbitrary Page
IDs or change a route's audience. Dynamic routes require the same authenticated,
audited authorization as static routes.

The default route is private to one session. A shared route MUST be visibly
identified in the UI and MUST never cross tenant boundaries. Route selection
MUST be revalidated on session resume and authorization change.

For every egress Module job, the host freezes one authorized membership snapshot
before the display prepare capability becomes usable. A private route snapshot
contains its one eligible session. A shared route snapshot contains the exact
eligible sessions under that route revision and offline policy. Preparation
creates a separate immutable display handoff record, strong-reference set, and
display cursor entry for each member. A display handoff record is gateway state
that retains the exact Blocks and Deliveries for one route member until
acknowledgement or terminal retirement; it is needed because the Core Claim
ends before a browser acknowledges display. A retry reuses the same snapshot; a
session joining later is not
inserted, and a route or Module cannot dynamically choose another Page. A
subsequent revocation prevents access and terminally retires that session's
prepared display state, but does not recompute the snapshot for other members.

Before dispatch, the host must persist the frozen membership. While the egress
actor Claim is established, the host route adapter writes an outbox record
containing `moduleJobId`, exact Core input digest, route revision, and a
durable membership revision. Membership history for that revision remains
queryable until the Module job is terminal. The gateway materializes and
compare-and-swap binds the exact member list under `(instanceId, moduleJobId)`;
the runtime does not dispatch `module.execute` until that binding is complete.
A crash or lost response replays the outbox and same revision. If the historical
revision is unavailable or conflicts, the claim is nacked/fails visibly; current
membership is never substituted.

The route's egress Module is the Core Page consumer. Per-session display cursors
are gateway cursors, not additional Core Page consumers or checkpoints.
Removing one session from a shared route MUST NOT remove or advance the route's
Core consumer. Retiring the route or a private route created for a session
removes its consumer only through the audited Core operation after the
configured terminal disposition.

### 4.3 Session lifecycle

A session has `opening`, `active`, `disconnected`, `closing`, `closed`, and
`revoked` states. Disconnect does not immediately mean close. A bounded resume
window MAY retain that session's unacknowledged display queue and exact egress
cursor. The configured expiry and retention behavior MUST be visible.

Closing, expiry, or revocation MUST:

- reject new ingress;
- cancel or resolve session-owned uploads and approvals;
- retire uncommitted upload-grant strong references and close active upload
  input/output (I/O) leases;
- apply the route's explicit close policy to accepted but not yet frozen ingress
  work, while authority revocation always uses the terminal cancellation and
  queue strong-reference release rule in Section 5.4;
- request cancellation of a frozen Module job without changing its immutable
  snapshot, and reconcile whether cancellation or commit won before releasing
  its queue strong references;
- retire the session's display handoff records, cursors, and display strong
  references according to policy without altering a shared route's Core
  consumer; and
- prevent an old browser or CLI credential from resuming the session.

A new shared-route session defaults to `from-now` at the gateway display
frontier. It MUST NOT receive display handoff records whose frozen membership
snapshot predates its membership. A new private route's Core consumer also
defaults to `from-now`. `from-head` or an older exact Core checkpoint is an
explicit, authorized private-route creation policy and remains bounded by the
Core retention frontier; it is not inferred from another session's display
cursor.

## 5. External ingress protocol

### 5.1 Message acceptance

An external message contains:

- a client-generated operation idempotency key unique within the session;
- a required `clientMessageId`, also unique within the session, that remains the
  stable client-side identity of this unchanged logical message;
- an authorized route ID plus its expected revision or server-issued revision
  token;
- optional text encoded as 8-bit Unicode Transformation Format (UTF-8);
- zero or more ordered committed upload-grant references returned by the upload
  flow, each bound server-side to one asset or view;
- optional non-authoritative locale and client timestamp metadata; and
- the expected session revision when optimistic concurrency is used.

At least one of text or media MUST be present. Image-only, audio-only, and
video-only messages are valid when the route and media policy allow that type.
The gateway MUST NOT insert placeholder text merely to make a media-only input
look textual.

Acceptance validates authorization, the exact route revision, schema, canonical
byte size, every server-side upload grant, route limits, `clientMessageId`, and
the idempotency key. It assigns a host `externalMessageId` and monotonic
acceptance sequence within the session/route queue. Concurrent submissions of
the same idempotency key and canonical input create one record and return one
receipt. Reusing the key or `clientMessageId` with different canonical input
fails with `IDEMPOTENCY_CONFLICT`; neither value is silently rebound.

For every media occurrence, acceptance atomically creates an idempotent
host-subsystem strong reference owned by the queued `externalMessageId` and
targeting the exact asset or view. A view strong reference retains its source
asset through the media graph. Only after those strong references and the queue
record commit may the gateway remove the corresponding upload-grant strong
reference and close any still-active upload access lease. The browser receives
an opaque upload grant, never a Core AccessLease or a generic retain/release
application programming interface (API).

With `persistent` durability, the queue record, strong references, ingress
message record, and idempotency receipt are durable before the `queued`
response. With `volatile` durability, the response uses an explicit
volatile-acceptance status and warns through structured status that process loss
may remove it; it MUST NOT use the durable claim.

The returned receipt MUST distinguish durable queue acceptance from Block
commit. A successful HTTP response alone MUST NOT be presented as proof that a
Block has reached an output Page.

### 5.2 Idempotent source activation requests

The gateway converts an eligible queue frontier into a source activation
request with an opaque `idempotencyKey` bound server-side to the tenant,
session, route revision, ingress Module, and first eligible acceptance
sequence. The key contains no queue authority and MUST NOT embed readable
session, route, or message identifiers.

Source activation requests use this three-step recovery procedure because the
gateway and Core stores do not share one atomic transaction:

1. The gateway first writes an immutable snapshot record in `prepared` state
   under the `idempotencyKey`, including the exact largest prefix, canonical
   snapshot digest, route/limit revision, and queue strong-reference owner
   records. No Module run is eligible yet.
2. It submits a source activation request with that same key to Core. Core
   durably returns or exposes the one mapped `moduleJobId`; a lost response is
   recovered through the read-only lookup by `idempotencyKey`, not a new
   request.
3. The gateway compare-and-swap binds the prepared snapshot to
   `(instanceId, moduleJobId)`. The runtime MUST NOT dispatch `module.execute`
   until this binding and the scoped ingress capability are readable and agree
   on the snapshot digest.

A crash before step 2 resubmits the same source activation request. A crash
between steps 2 and 3 queries the existing mapping and finishes the binding. A
conflict between one `idempotencyKey`, snapshot record, or `moduleJobId` fails
closed and leaves the queue strong references live for operator or
reconciliation policy.
An implementation MUST NOT replace this recovery procedure with two
uncoordinated writes.

The private ingress message record contains at least the route and revision,
tenant/session scope, ordered acceptance sequences, `externalMessageId` and
`clientMessageId` values, canonical message digests, attachment identities,
`hasMoreAtFreeze`, configuration/limit revision, and snapshot digest. This
record is versioned gateway state used for commit recovery and display
reconciliation; it is not Block payload or Module-chosen metadata.

Duplicate submission with one live `idempotencyKey` maps to the same Core
`moduleJobId` and never creates a second Module job. Before dispatching
`module.execute`, the host queries the Module job outcome. If that Module job
already committed, the host
returns the original outcome, completes any pending queue reconciliation, and
MUST NOT invoke the Module again. If it is still retryable, every new `runId`
receives the exact frozen snapshot through the scoped ingress capability. An
`idempotencyKey` from a source activation request, Module job ID, message ID,
or route ID alone authorizes no read.

If messages arrive while the ingress Module actor is running, they remain
queued for a later source activation request. If a bounded prefix leaves more
work, the gateway schedules the next request only after the current Module job
has committed or reached an explicit terminal disposition. Retryable work
retains the frontier and blocks later source activation requests for that
route.

### 5.3 Deterministic batching

One action MUST contain messages from exactly one tenant, session, and route.
When source activation request preparation begins, the batch is the largest
prefix of currently pending messages, ordered by server acceptance sequence,
that fits every configured limit. That prepared batch becomes the only action
input after the three-step recovery procedure completes. The algorithm MUST NOT
sample, reorder, skip a later-small item ahead of an earlier-large item, or
depend on object enumeration order.

Limits MUST include message count, the exact canonical proposed Block bytes
including boundary items, attachment count, ingress message record
bytes, and the Block/attachment limits from the Core and media contracts.
Selection uses the frozen route and limit revision. It MUST NOT depend on later
configuration or wall-clock changes.

An individual message that cannot fit an otherwise empty batch is terminally
failed before a source Module job is created. In one host transaction or
recoverable outbox step, the gateway records `CLAIM_ITEM_OVERSIZE`, publishes a
safe client status, releases that message's queue strong references, advances
the frontier, and makes the next item eligible. A stale already-scheduled
request is reconciled without `module.execute`. This rule also handles a message
accepted before an authorized limit decrease; it never silently truncates or
stalls later input.

Retry of the same `moduleJobId` MUST present the exact same batch, even if new
messages have arrived. A fresh Module job begins at the first sequence after
the committed prefix.

### 5.4 Cancellation, revocation, and frontier ownership

Cancellation before snapshot freeze atomically marks the message cancelled,
removes its queue strong references, advances the frontier, and prevents
creation of a source Module job. An ordinary session close MAY use an explicit pre-authorized drain
policy. Authentication, tenant, session-authority, or route-authority revocation
MUST terminally cancel all not-yet-frozen messages; it cannot opt into drain.

After freeze, no individual message can be removed from or edited inside that
Module job. Cancellation becomes `cancel-requested` and requests Core Run
cancellation. If the Module job commits first, commit wins and the client sees
`committed-after-cancel-request`. To make a frozen cancellation effective, the
Core Module job must first reach an explicit terminal no-commit/abandoned
disposition. Only then may the gateway release the cancelled message's strong
references and make any remaining messages from that abandoned batch eligible
under a fresh source activation request while preserving their original
acceptance order.
Until that disposition is proven through the Module job outcome, every queue
strong reference remains live.

If cancellation races preparation of a source activation request that is not
yet mapped to a Core Module job, the gateway may compare-and-swap the snapshot
record to terminal only after lookup by `idempotencyKey` proves no mapping
exists. If a mapping exists or its outcome is temporarily unknown, the gateway
completes the Module job binding and uses the post-freeze rule above; it never
assumes that absence of a response means absence of a Module job.

A route revision change never edits a frozen snapshot or changes its Page set.
The old revision either drains the snapshot or reaches the configured terminal
disposition. Revocation always prevents the old principal/session from reading
new status or display data even if an already-frozen Module job wins its commit
race.

### 5.5 Faithful Block proposal

Every dispatched ingress action has a non-empty frozen snapshot and MUST return
exactly one BlockProposal using `dolly.content/1`. Empty, cancelled, oversized,
or already-committed source activation requests are resolved by the host before
dispatch. Returning no proposal for a valid snapshot is `RESULT_INVALID`; it
cannot replace a prior committed result or retire queue work.

`dolly.console.message-boundary/1` is a reserved content schema name.
`schema-registry.md` owns the mechanism — the reserved namespace, where
publisher identity comes from, what does not establish it, validator-digest
pinning and drift, and why a name collision must fail before Module start — and
this document does not restate it.

What this document fixes is the Console-specific part: the value schema accepts
exactly an empty JavaScript Object Notation (JSON) object, the item carries no
extra Core references, and producer authority belongs only to the exact Console
ingress publisher and Module role. Consumer renderers for generic, LLM, and
Console surfaces are separate entries owned by their respective publishers, and
holding one never grants producer authority.

Section 15.1 item 8 records which part of that enforcement exists today and
which acceptance tests are reachable before `dolly.extension-package/2` exists.

The exact boundary item is:

```json
{
  "type": "data",
  "schema": "dolly.console.message-boundary/1",
  "value": {}
}
```

The canonical JSON value, not whitespace in this illustrative line, is
normative. The item is a closed `data` item as defined by `block-payload.md`
section 2: `type`, `schema`, and `value` are the only fields, and an empty
`value` is the whole content.

The boundary carries no inline fallback representation. A second
representation of one content item would let two consumers disagree about what
the Block says: an assembler could read the structured `value` while an
extractor reads the fallback text, and the two views then diverge with no way
to say which was authoritative. Presentation belongs to the renderer, not to
the Block, which `OWNER-DATA-001` fixes as a JSON information unit.

A renderer that does not recognise the schema therefore shows nothing for this
item. That is the correct degradation for a delimiter: the boundary's whole
meaning is "a new message starts here", and a reader who cannot use that
grouping loses nothing by not seeing it. A registered LLM renderer maps the
boundary to a new delimited untrusted user-content unit without emitting IDs.
A Console renderer MAY visually group the following items, and MAY draw a
separator of its own choosing, while preserving the boundary in canonical
state; the Console extension publishes the constant
`MESSAGE_BOUNDARY_FALLBACK_TEXT` (`"---"`) for renderers that want the
historical separator text.

Messages are encoded in acceptance order. Each message contributes exactly:

1. one `dolly.console.message-boundary/1` `data` item;
2. its exact text bytes as
   `{"type":"text","text":<exact text>,"format":"plain"}` when text is
   present, with no `language` field; and
3. its ordered media occurrences as
   `{"type":"media-reference","mediaId":<id>}`
   with no caption or accessibility field.

Each occurrence is one content item, even when two occurrences target the same
Media. Repeated content items preserve occurrence order and do not create
duplicate reference-graph dependency edges. The Console
injects no `sessionId`, route, sequence, `moduleJobId`, `runId`, external/client
message ID, Delivery/Page ID, retry state, or `hasMore` into a `data` item or any
other content item; those values remain in host-owned Module job records. Exact user
text may coincidentally contain ID-like strings, but they remain inert user text
and never grant host authority.

Before accepting the result, the host faithfully recomposes the expected
proposal from the frozen snapshot and verifies canonical equality: exact item
count/order/text bytes, one boundary per message, media occurrence order,
exact Media IDs, absence of additions or omissions or optional fields, the
exact registered schema/validator digest, and
complete result digest. The
BlockProposal summary is absent. This contextual check is in addition to generic
`dolly.content/1`, capability, reference, and media validation. The initial
Console ingress role emits no Module description replacement or change to Module-held
references; a later role revision must explicitly version and test such a field.

Core assigns the Block ID, sequence, authenticated Module source, and timestamp.
Per-session/user provenance and optimistic reconciliation remain trusted host
metadata and MUST NOT be inferred from payload strings. Console-generated
metadata and Media references contain no local path, base64 media, raw object
storage service (OSS) key, signed URL, credential, or arbitrary fetch
instruction. User text that looks like one of those remains inert and grants no
file, media, or network authority.

On Core commit, the non-empty static output Page set creates the normal
`delivery` strong references before the result becomes committed. The gateway then
observes the expected committed `resultDigest`, records the committed Block and
Delivery IDs in its ingress message record, marks the exact messages committed, and
retires their host-owned queue strong references idempotently. A nack or retry leaves the
queue strong references untouched. A terminal no-commit/abandoned outcome releases or
requeues strong references only according to Section 5.4. A crash at any point is recovered
by querying the Module job outcome; it never invokes an already-committed Module job
or creates a second Block.

## 6. Egress and display semantics

### 6.1 Sink execution

The egress sink receives the core's current bounded deterministic input batch,
ordered and grouped according to `core-runtime.md`, plus an opaque capability
binding to the host-frozen route revision and membership snapshot. Session/member
identities are not disclosed to the Module. The Module assembles the canonical
successful result, which contains no BlockProposal, Module description replacement, or
`ModuleRetentionChange`, computes its expected result digest, and invokes the
scoped display prepare capability before returning that exact result.

The gateway derives all input, route, and member identities from authenticated
host state rather than Module arguments. For each frozen member, prepare creates
one immutable display handoff record keyed by
`(instanceId, moduleJobId, sessionId)` with
Block and Delivery IDs, occurrence information, route revision, input digest,
membership-snapshot ID, a route-local preparation ordinal, and safe presentation
metadata. It also creates idempotent host-owned display handoff strong
references for every referenced Block before reporting prepare success. Those
strong references transitively retain Media referenced by the prepared Blocks
after Delivery strong references become eligible for retirement.
Final per-session display sequences are not allocated during prepare, because a
nacked or abandoned Module job must not leave a client-visible cursor gap.

Under a non-lossy route, all member batches and strong references prepare atomically or none
do. Capacity failure returns a typed retryable `BACKPRESSURE` error from the
Module execution; the Module does not return a successful no-output result, and
Core owns the resulting nack/retry. Under an explicitly lossy route, prepare may
record a per-member terminal `not-presented` disposition without a display strong reference
only when configured, visible, audited, and counted.

An empty membership snapshot is `BACKPRESSURE`/`ROUTE_UNAVAILABLE` for a
non-lossy route unless its offline policy has an eligible retained member. A
lossy route may instead record an audited route-level `not-presented` outcome. A
member whose authorization is revoked after freeze is never made readable;
prepare or reconciliation records a security terminal disposition and removes
only that member's strong references without substituting another session.

A lost prepare response is resolved by querying the same preparation
idempotency key and expected digest; it never creates another preparation. The host role
validator accepts the canonical no-Block result only when an exact prepared or
allowed terminal record exists for every frozen member and matches the input,
membership, and expected result digests.

Display handoff records in `prepared` state are hidden from clients. After Core
commits the exact no-Block result and input acknowledgement, the Module job
outcome activates all matching records in
the route's Module job/preparation order and atomically assigns gap-free
per-session contiguous display sequences. A terminal non-display disposition
advances the internal preparation order without consuming a client sequence. If
the result is negatively acknowledged or retryable, the same Module job reuses
its records in `prepared` state without duplication. If the Module job reaches
a terminal non-commit
disposition, the gateway retires records in `prepared` state and strong
references idempotently. Recovery queries the outcome and expected digest; it
does not infer commit from an
extension return or notification.

Core input acknowledgement therefore means that the display handoff required
by the configured durability and its strong references were prepared and the
exact Module result committed. Browser
`display.ack` remains a separate gateway cursor operation. A disconnected
browser never holds an active Core claim open indefinitely.

The egress role MUST return no BlockProposal for every successful execution.
The host role validator rejects any proposal as `RESULT_INVALID` before ack.
Consequently, even an accidental input/output Page overlap cannot create output
recursion; any future output-producing behavior requires a separately
configured source Module.

### 6.2 No global cross-session history

The Console MUST NOT maintain one mutable global transcript shared across
sessions. Display state and strong references are scoped by tenant, session,
route revision, and the frozen membership snapshot. A session sees:

- its own queued ingress status;
- display handoff records delivered under its authorized route and start policy;
- host tool/approval events explicitly addressed to it; and
- bounded connection and operational status.

Acknowledging, closing, expiring, or revoking a session atomically advances or
retires its display state and removes only its display handoff strong references
under policy. It does not delete a Block still rooted elsewhere or alter the
shared route's Core consumer. Cross-session durable memory requires a separate
configured Module and MUST NOT arise from Console history as a side effect.

### 6.3 Self-loop and retry deduplication

The UI MAY show an accepted ingress message immediately as a queued item. When a
committed ingress message record maps those messages to a Block and that Block
returns through an eligible egress route, the gateway reconciles the optimistic
item by that private record instead of appending a second visual copy. The Block
payload itself carries no external message or session ID.

Deduplication MUST be scoped to tenant, session, route, core `moduleJobId`,
Block ID, and relevant Delivery IDs. There MUST NOT be a global `seenBlockIds`
set: another session, another route, or a deliberate later Delivery of the same
Block can be a legitimate occurrence.

Repeated Deliveries of one Block inside a Core Block delivery group are
displayed once with optional occurrence/route detail. A retry of one egress
Module job is idempotent. A genuinely new later Delivery MAY create a new
occurrence according to route policy, but it MUST not recreate the original
optimistic self-echo.

### 6.4 Block presentation

The Console MUST support a safe fallback for every valid Block payload schema:
source, summary, creation time, route/Page provenance, and a bounded structured
payload view. A richer renderer MAY be registered for a known schema, but an
unknown schema MUST remain inspectable without executing content.

Delivery attempts, retry state, occurrence count, and Page provenance are
display metadata, not mutations of the immutable Block. The UI MUST distinguish
user ingress, Module output, tool/approval events, and operational errors using
authenticated Core source and the ingress message record, never an
extension-provided display label alone.

### 6.5 Display acknowledgement and resume

Each `(tenant, session, route revision)` display stream has a server-assigned
monotonic contiguous sequence. `display.ack` carries an idempotency operation ID,
expected session revision, and `ackThrough` sequence. It means that the client
has incorporated every display item through that sequence into its resume state;
it is not proof of exactly-once rendering or a Core Delivery ack.

The gateway accepts an acknowledgement only up to the highest contiguous
sequence issued to that authenticated session. Repeating the current value is
idempotent, a lower value is a no-op, and a future, skipped, cross-session,
cross-route, expired, or stale-revision value fails visibly. Concurrent tabs use
the same compare-and-swap cursor; neither may move it backwards or create a gap.

Advancing the cursor and moving each fully covered display handoff strong
reference to either
`removed` or host-owned `release-pending` is one host transaction or recoverable
outbox operation. A strong reference with no active browser response/grant is removed. A
strong reference with a bounded response or signed grant remains until
that exact grant is terminal or expired, then reconciliation removes it. No new
browser grant is issued after acknowledgement, close, or revocation. A lost ack
response is resolved by querying the operation ID or cursor and retrying the same
operation, never by guessing a new cursor.

## 7. Media input and output

### 7.1 Upload flow

Text, image, audio, and video inputs use the media capability and limits in
`media.md`. The browser or CLI MUST stream bytes to an authenticated upload
operation; media MUST NOT be embedded as unbounded base64 in a JSON or WebSocket
control message.

The upload lifecycle is:

`created -> uploading -> validating -> available | failed | cancelled`

The server returns an opaque upload ID scoped to tenant and session. It enforces
declared length where present, streamed byte limits, Multipurpose Internet Mail
Extensions (MIME) type sniffing, decoder limits, timeout, quota, and
cancellation. A completed upload returns an opaque session-scoped upload grant
whose server record names the exact `mediaId`. When the Media becomes
`available`, registration creates a host-owned `console-upload-grant` strong
reference with the same configured durability; an AccessLease is used only for
bounded active I/O and is not the ownership reason while an available grant
waits for enqueue. The protocol does not return a Core AccessLease, raw Media
authority, or object-store locator to the client.

External message acceptance consumes or validates the grant according to its
finite reuse policy, creates the queued-message strong reference described in
Section 5.1, and only then removes the upload-grant strong reference when no
authorized use remains. Each permitted reuse has its own durable use record,
queue strong reference, and finite quota; one enqueue cannot remove the last
grant strong reference while another accepted use is not yet rooted. Upload
cancellation or expiry removes the grant strong reference after all active
handoffs resolve. Failed enqueue leaves an otherwise-valid grant and strong
reference available for its bounded lifetime, while terminal media validation
failure removes it. Active I/O leases close independently at their normal
terminal boundary. A retry with the same operation ID observes the original
transition and cannot double-remove a strong reference or bind the grant to
another target.

One message is accepted only after every referenced upload is `available`.
Partial upload success MUST remain visible and recoverable, but MUST NOT produce
a message whose Media references are missing. Retrying upload chunks or
commit uses operation-specific idempotency.

The browser experience MUST support file selection, drag-and-drop, and paste for
applicable media without making any one interaction mandatory. Camera or
microphone capture MAY be offered only through explicit browser permission and
the same validation pipeline.

Image-only input is a required acceptance case. The composer send action MUST be
enabled when a valid image is attached and text is empty.

### 7.2 Output media resolution

Incoming Block Media references are resolved only through the Core Media
capability.
The renderer MUST NOT interpret a payload string as a local path, object key, or
fetchable URL. It requests permission to display the exact Media item and crop.

The display handoff record holds the strong reference; the browser permission
does not. Grant issuance records a bounded active response or signed expiry
under that existing strong reference. If display acknowledgement races an
active grant, the strong reference enters `release-pending` and remains until
that record is terminal; the Console does not invent a `browser-display`
AccessLease kind absent from Core or Media. A client cannot prolong lifetime by
replaying a URL, lease-like value, or stale grant.

Private media SHOULD be served by the Console gateway through authenticated
same-origin requests by default. A short-lived signed or stable public URL MAY
be returned only when the exact media grant and route disclosure policy permit
it. The browser never receives an OSS access key, provider credential, or host
filesystem path.
An explicitly public stable URL carries no post-retention availability promise
and does not keep a display handoff strong reference forever.

The UI MUST provide bounded, aspect-stable previews for images; native or
accessible custom controls for audio and video; explicit loading, unavailable,
expired, and unsupported states; and an authorized download action when policy
allows. Full-resolution loading SHOULD be user initiated or lazy. Temporary
object URLs and display grants MUST be revoked or released when no longer used.

## 8. External client protocol

### 8.1 Versioning and operations

The browser and CLI MUST use the same versioned semantic protocol. Different
transports MAY frame it differently, but they MUST share schemas, authorization,
idempotency, limits, status transitions, and error codes.

The initial protocol MUST define at least:

- session open, resume, close, and status;
- authorized route list and route selection;
- upload create, stream, commit, status, and cancel;
- message enqueue, cancel, status, and explicit terminal retry;
- display subscribe/resume and the contiguous `display.ack` operation from
  Section 6.5;
- approval inspect and resolve; and
- connection heartbeat, backpressure, session revocation, and version errors.

Every mutation carries an operation ID and expected session revision where
applicable. Events carry stable IDs and a per-session sequence so reconnect can
resume without relying on WebSocket frame history. Unknown required event types
or incompatible versions MUST fail visibly.

The external schemas distinguish `clientMessageId`, operation idempotency key,
host receipt ID, and server status event ID. None is accepted as tenant, route,
media, queue, Module job, or capability authority. Route-bearing mutations also
carry the expected route revision or an equivalent server-issued route token;
stale revisions cannot silently target a replacement Page topology.

### 8.2 Browser transport

The browser uses authenticated same-origin HTTP for bounded commands and
streaming upload/download. A WebSocket or Server-Sent Events (SSE) channel MAY
deliver status and display events. WebSocket use MUST follow authentication,
exact Origin, schema, message-size, heartbeat, connection, replay, and
backpressure requirements in `security-operations.md`.

The client MUST be able to recover status by operation ID after a transport
disconnect. It MUST NOT infer failure solely because a response was lost.

### 8.3 CLI parity

The CLI calls the same gateway operations and MUST NOT write the queue, Page,
BlockStore, media store, or approval database directly. It uses the same route
authorization and idempotency rules and receives the same status/error kinds.

Credentials MUST come from protected standard input, an operating system
credential store, or an authenticated local Console gateway session; they MUST
NOT be placed in command-line
arguments or URL query strings. Non-interactive mode SHOULD provide structured
JSON Lines events and MUST exit non-zero on a terminal failed operation. A
transport timeout with unknown server outcome MUST be reported as unknown and
resolved by querying the operation ID, not blindly retried with a new ID.

## 9. Acknowledgement, retry, and backpressure user experience (UX)

Ingress items use these user-visible semantic states:

- `uploading` or `validating` for media preparation;
- `queued-durable` or `queued-volatile` according to the declared Console
  durability;
- `accepted` after an immutable source Module job snapshot is frozen;
- `committed` after the Block and configured output Deliveries commit;
- `cancel-requested` while a frozen Module job outcome is unresolved;
- `committed-after-cancel-request` when commit wins that race;
- `retrying` with attempt and next retry when runtime policy retries;
- `failed` with a stable safe error and retryability; and
- `cancelled` when cancellation reaches a terminal boundary.

The UI MUST NOT replace a retrying/failed item with an unqualified success or
remove it silently. Repeating an enqueue idempotency key always returns the
original receipt, including its terminal failure; it is not a retry command. An
explicit terminal retry is a separate mutation with its own operation
idempotency key, references the original external message, and may re-arm only
unchanged canonical input when policy permits. Editing text, Media references,
route, or approval creates a new `clientMessageId` and a visible relationship to
the prior attempt.

Display items have `received`, `rendered`, and `acknowledged-for-resume` client
states. These are not core Delivery states. Diagnostics MAY expose core retry
and dead-letter details to an authorized operator, but ordinary UI labels MUST
not imply exactly-once external side effects. A display item remains eligible
for resume until the server accepts its contiguous cursor acknowledgement or its
retention policy reaches a visible terminal disposition.

The gateway MUST enforce finite configurable limits for:

- text and control-message bytes;
- Media references per message and concurrent uploads;
- queued messages and metadata bytes per tenant/session/route;
- source and egress batch count/bytes;
- unacknowledged display items and bytes;
- requests, messages, uploads, reconnects, and authentication attempts per time
  window; and
- session lifetime, idle time, resume window, and upload lifetime.

Media byte limits come from `media.md`; HTTP/WebSocket control limits come from
`security-operations.md`; Block and claim limits come from `core-runtime.md`.
Effective limits MUST be advertised to authenticated clients. Queue saturation
returns a typed backpressure result with retry guidance; it MUST NOT silently
drop, reorder, or accept work that cannot be retained.

## 10. Tool and approval states

Tool calls and approval requests are host control events, not trusted Hypertext
Markup Language (HTML), and are not inferred by parsing arbitrary Block text.
Each approval event MUST contain a stable approval ID, trusted tool identity,
redacted validated arguments, effect class, resource scope, requesting
session/run, expiry, and policy explanation.

The Console MUST represent at least:

`pending -> approved | denied | expired | cancelled`

and, after an approved invocation:

`approved -> executing -> completed | failed | outcome-unknown`.

Only a principal authorized for the exact tenant, session, tool, effect, and
scope may resolve an approval. Approval uses the latest server revision; changed
arguments or expired/revoked capabilities invalidate it. A model statement or
extension-provided visual label cannot approve itself.

The UI MUST make destructive, external-communication, credential, and
administrative effects distinguishable before confirmation. It MUST show
`outcome-unknown` without offering an automatic blind retry. Browser and CLI
approval operations use the same server authorization and audit path.

## 11. User interface information architecture

The first screen is the usable Console, not a landing or marketing page. The
design SHOULD be quiet, work-focused, compact, and optimized for repeated
inspection and action.

### 11.1 Desktop

The desktop layout has:

- a restrained top bar for instance, connection, current session, and global
  operational status;
- a left navigation region for authorized routes and session-local views;
- a primary activity stream and composer;
- an optional right inspector for Block provenance, Page/Delivery information,
  media metadata, retries, tool details, and safe structured payloads; and
- overlays only for focused confirmation, approval, or configuration tasks.

Page sections SHOULD be unframed. Cards are reserved for repeated stream items,
dialogs, and genuinely bounded tools; cards MUST NOT be nested decoratively.
Stream density, typography, and metadata hierarchy MUST remain appropriate for
an operational console rather than a promotional dashboard.

### 11.2 Responsive behavior

At narrower widths, navigation and the inspector become independently
dismissible drawers or full-width views. The activity stream remains primary.
The composer stays reachable above the safe area and on-screen keyboard without
covering the latest item or approval controls.

Fixed-format controls, preview regions, attachment tiles, status indicators,
and icon buttons MUST have stable responsive dimensions so loading, hover,
retry, and localization do not shift surrounding layout. There MUST be no
unintended horizontal page scrolling at supported widths.

### 11.3 Stream and composer

Each stream item MUST expose, at an appropriate density:

- source kind and safe display identity;
- committed, queued, retry, or delivery status;
- text or a safe structured fallback;
- media previews and explicit unavailable states;
- route/Page provenance when useful; and
- actions relevant to that item, such as retry, inspect, cancel, download, or
  approval resolution.

The composer contains a multiline text input, attachment tray, upload progress,
route context, send action, and cancellation where supported. Familiar icon
buttons SHOULD use the project's icon library, have accessible names, and show
tooltips when meaning is not obvious. Text MUST fit at all supported viewport
and locale sizes; font size MUST NOT scale with viewport width.

The interface MUST define polished empty, loading, reconnecting, offline,
backpressured, partial-upload, failed, revoked-session, and unsupported-media
states. It MUST not use feature-tour copy or decorative content in place of the
actual workflow.

## 12. Accessibility and localization

The target is Web Content Accessibility Guidelines (WCAG) 2.2 Level AA for the
supported browser surface. Required behavior includes:

- semantic landmarks, headings, lists, forms, buttons, and dialogs;
- complete keyboard operation with visible focus and logical focus restoration;
- accessible names for icons, previews, controls, status, and media;
- status announcements that are useful but do not repeatedly interrupt screen
  readers during streaming;
- no information conveyed by color alone;
- sufficient contrast in normal, hover, focus, disabled, error, and selected
  states;
- reduced-motion support and no required motion-only interaction;
- touch targets appropriate for mobile use; and
- audio/video controls usable by keyboard and assistive technology.

Virtualized streams MUST preserve reading order, focus, stable item identity,
and access to newly arrived items. New output MUST NOT steal focus. The UI
SHOULD preserve the user's scroll position and offer an explicit new-items
control when they are reading older visible content.

All product strings MUST come from localization resources. Messages MUST use
locale-aware plural, number, date, time, duration, and byte formatting; avoid
sentence fragments assembled in code; support text expansion; and provide a
documented fallback locale. Layout MUST support right-to-left (RTL) direction
without reversing media playback semantics, code, IDs, or chronological
meaning.

User and Block content is not automatically translated. Stable server error
codes are localized by the client while the safe diagnostic ID remains
available. A locale change MUST NOT alter protocol IDs, batching, ordering,
authorization, or stored user content.

## 13. Browser and protocol security

The Console inherits all mandatory controls in `security-operations.md`. In
addition:

- loopback-only binding is the default; remote/public mode requires all public
  deployment security controls, not only a changed listen address;
- every private read, route query, upload, enqueue, display, tool, approval, and
  status operation requires authentication and tenant/session authorization;
- shared-route membership is revalidated for every display read and grant;
  revocation makes the member's display handoff record in `prepared` state
  inaccessible and triggers its audited terminal disposition and
  strong-reference retirement without adding a replacement member to the
  frozen snapshot;
- browser state-changing requests require CSRF protection, and WebSocket
  upgrades require exact Origin validation;
- route and media references are opaque, unguessable where appropriate, and
  checked on every use;
- signed media URLs, session cookies, pairing codes, CSRF tokens, capability
  handles, prompts, and uploaded bytes MUST NOT appear in routine logs;
- queue/display capability handles and Core AccessLeases MUST NOT cross the
  browser or CLI protocol; only identifiers explicitly declared by the external
  protocol, such as an authorized message receipt or display cursor, may cross
  that boundary, while internal Module job, Delivery, Page, and ingress message
  record fields stay server-side except in separately authorized diagnostics;
- session/route/message/Module job correlation MUST NOT be injected into Block
  payload metadata; ID-like text supplied by the user remains inert content;
- browser caches and service workers MUST NOT retain private session/media data
  beyond explicit policy; and
- logout, revocation, and tenant change MUST clear session-scoped client state.

The production UI MUST use a restrictive CSP with no `unsafe-eval`, no arbitrary
inline script, no third-party administrative-origin script, and narrowly scoped
media/connect sources. Trusted Types or an equivalent reviewed sink policy
SHOULD protect Document Object Model (DOM) injection sinks where supported.

Plain text is rendered as text. Markdown or rich Block renderers MUST use a
versioned allowlist sanitizer, disable raw HTML and active content, validate URL
schemes, and apply `noopener`/`noreferrer` to external navigation. Filenames,
tool arguments, model output, provider errors, structured payloads, and Scalable
Vector Graphics (SVG)-like content MUST remain inert. The UI MUST NOT fetch a
URL found only in content.

## 14. Errors, observability, and audit

Protocol errors contain a stable kind, safe localized message key/parameters,
retryability, operation ID, and optional diagnostic ID. They MUST NOT expose a
stack trace, host path, credential, signed URL, cross-tenant identity, or raw
provider response.

The initial Console-specific taxonomy MUST distinguish at least:

- `AUTH_REQUIRED`, `SESSION_EXPIRED`, and `SESSION_REVOKED`;
- `ROUTE_DENIED` and `ROUTE_UNAVAILABLE`;
- `IDEMPOTENCY_CONFLICT`;
- `MESSAGE_INVALID`, `CLAIM_ITEM_OVERSIZE`, `MEDIA_INVALID`, and
  `MEDIA_NOT_READY`;
- `QUEUE_FULL` and `BACKPRESSURE`;
- `CLAIM_MODULE_JOB_MISMATCH`, `MODULE_JOB_INPUT_PAGE_SET_CHANGED`,
  `MODULE_JOB_ALREADY_ACTIVE`, and `CANCEL_TOO_LATE`;
- `MODULE_JOB_ID_INVALID`, `MODULE_JOB_RESULT_CONFLICT`,
  `MODULE_JOB_CLAIM_NOT_ACTIVE`, and `MODULE_JOB_OUTPUT_INVALID`;
- `MODULE_RESULT_COMMIT_RECORD_MISSING`,
  `MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT`,
  `MODULE_RESULT_COMMIT_DOCUMENT_INVALID`,
  `MODULE_RESULT_COMMIT_LIMIT_EXCEEDED`, `MODULE_RESULT_COMMIT_LOCKED`, and
  `MODULE_RESULT_COMMIT_IO_FAILED`;
- `ROUTE_REVISION_RETIRED` and `DURABILITY_PROFILE_MISMATCH`;
- `DISPLAY_RESUME_EXPIRED` and `DISPLAY_ACK_INVALID`;
- `SCHEMA_REGISTRY_CONFLICT`; and
- `PROTOCOL_INCOMPATIBLE`.

Metrics SHOULD cover authenticated sessions, queue depth/bytes, oldest message,
batch size, commit latency, retries, display backlog, upload outcomes, media
resolution, reconnect, approvals, backpressure, and sanitized renderer errors.
Tenant/session/message/Block IDs MUST NOT become high-cardinality metric labels.

Audit events MUST cover session authentication/revocation, route changes,
external enqueue/cancel/manual retry, lossy not-presented outcomes, approval
resolution, and security-policy denial. Audit payloads use IDs and safe metadata,
not message text, media bytes, tool secrets, or signed URLs.

## 15. Required conformance and acceptance tests

### 15.1 Runtime and protocol

Automated deterministic tests MUST verify:

1. concurrent duplicate enqueue idempotency keys and `clientMessageId` values
   produce one receipt and strong-reference set, while conflicting reuse fails;
2. `idempotencyKey` values from source activation requests map retries to one
   globally instance-unique `moduleJobId`
   while `runId` changes, and a committed source activation request is
   reconciled through the Module job outcome without another `module.execute`;
   process termination after snapshot preparation, after Core idempotency-key
   mapping, and after Module job binding recovers through the same three-step
   procedure without a second Module job;
3. snapshot digest, ordered messages, Media identities, route/limit
   revision, and `hasMoreAtFreeze` remain exact across retries while later
   arrivals remain for the next source activation request;
4. deterministic largest-prefix batching uses exact proposed-Block bytes,
   count, Media references, and ingress message record limits;
5. an individually oversized frontier message receives a durable terminal
   result, releases only its strong references, survives a crash during retirement, and
   cannot stall the next valid message;
6. every dispatched ingress action returns exactly one faithful
   `dolly.content/1` proposal with one ID-free message boundary per message,
   exact text/Media order and Media IDs;
7. changed text, missing/extra/reordered boundaries, altered Media targets,
   extra summary/Module-description/retention state, no proposal, and a retry
   with another result digest are rejected without retiring queue work;
8. built-in registry authorization accepts the exact Console producer publisher,
   validator digest, and limits, while generic/LLM/Console renderers register as
   separate consumers; a counterfeit package, producer grant inferred from a
   renderer/signature, reserved-name claim, ID collision, or validator drift
   fails before Module start.

   **This requirement is not implemented and has nothing to attach to yet.**
   Dolly has no schema registry: there is no registry record, no publisher
   identity, and no recorded validator digest anywhere in the runtime, so
   "registry authorization" cannot be tested as written and MUST NOT be
   described as satisfied. Building a private lookup table inside the Console
   extension would not satisfy it either — a producer that checks its own
   authority has not been checked, and a table that only the Console consults
   would read as a guarantee the system does not provide.

   The security property underneath it is narrower and does hold on its own:
   only the Console ingress role may emit a content item carrying the reserved
   schema `dolly.console.message-boundary/1`. It matters because this Block
   stream is assembled into LLM context, so any Extension able to forge a
   message boundary can inject fabricated conversation structure into that
   context. Enforcement therefore belongs at Block commit in the Core, where
   the producing Module is already authenticated, and not in the extension that
   would be checking itself.

   Until the registry exists, conformance for this item is: the Core rejects a
   `dolly.console.message-boundary/1` content item from any source other than
   the authenticated Console ingress capability. That reserved-name check is
   implemented: `reserved-content-schema.ts` holds a closed compiled-in list of
   reserved names with a host-configured producer and a fail-closed default, and
   `BlockStore.normalizeInput` refuses an unauthorized item before a Block
   identifier is allocated. Granting the Console ingress Module that producer
   entry is deployment wiring and is tracked separately; without it the boundary
   is refused for every source, which is the intended default.

   The general mechanism now has a contract: `schema-registry.md` defines name
   ownership, the reserved namespace, publisher identity, validator-digest
   pinning, drift, and collision detection. It is a contract only — nothing
   implements it — and it cannot be implemented against package schema version 1,
   because `extension-process-protocol.md` Section 3 requires
   `requestedCapabilities` to be empty there and defers payload schema
   registration to a later package schema.

   That split determines what this item can be tested against **today**. Of the
   thirteen acceptance tests in `schema-registry.md` Section 10, four are
   reachable now because they need only the reserved-name check: a reserved name
   with no configured producer is refused for every source (item 3); a refusal
   allocates no Block identifier and stores no record (item 10); the existing
   `dolly.content/1` validation is not relaxed (item 11); and a name that is
   merely similar to a reserved one is unaffected (item 12). A fifth, that the
   grant binds an exact producer identity rather than a shape, holds today only
   in the narrower form the interim check supports — it binds the Block source
   identity, not the `(extensionId, packageVersion, moduleKind)` triple that
   Section 5.1 requires.

   The remaining eight need a manifest that can declare a registration, a
   registration set built before Module start, or both, so they wait on
   `dolly.extension-package/2` and on Module execution being enabled. This item
   MUST NOT be reported as satisfied by running the four that are reachable;
9. crash injection before and after queue record and strong-reference creation,
   snapshot freeze, Block commit, Delivery append, outcome observation, ingress
   message record mapping, and queue strong-reference retirement causes neither
   missing media nor duplicate Blocks;
10. collector runs at every ingress handoff prove that active upload I/O,
    upload-grant strong references, every authorized grant reuse, queued-message
    strong references, Block attachment edges, and Delivery strong references
    preserve exact reachability and eventually release it;
11. an egress Module job freezes the exact authorized shared-route membership,
    prepares one per-session display handoff record, cursor, and strong-reference
    set, and never adds a late joiner, substitutes a member after revocation, or
    changes static input Pages;
    crash/replay of the persisted membership record uses the original membership
    revision and fails rather than substituting current membership;
12. crash injection before and after display handoff strong-reference preparation,
    Core ack, Module job outcome activation, display acknowledgement, and display strong-reference
    retirement is idempotent, never exposes an uncommitted display handoff
    record in `prepared` state, and
    leaves no client sequence gap for a nacked/abandoned preparation;
13. a collector run after Core Page ack but before browser display ack proves the
    display handoff strong reference preserves the Block and all media, while independent member
    acknowledgements release only their own strong references; acknowledgement racing an
    active response/signed grant moves the strong reference to `release-pending` until the
    bounded grant is terminal and permits no post-ack grant issuance;
14. every egress BlockProposal is rejected; non-lossy capacity failure produces
    Core nack/retry, while configured lossy `not-presented` is terminal, visible,
    audited, and without strong references;
15. cancellation before freeze, after freeze, concurrent with commit, after
    commit, during session revocation, and during route revision replacement
    follows Section 5.4 without editing a frozen snapshot or rerouting Pages;
16. self-loop reconciliation using the ingress message record replaces the optimistic item without
    putting external/session/route/Module job IDs into Block content;
17. the same Block remains independently visible to another frozen member and a
    genuine later Delivery is not removed by global deduplication;
18. duplicate, lower, future, skipped, stale-revision, concurrent-tab,
    cross-route, cross-session, and expired `display.ack` cases preserve one
    contiguous cursor and the correct strong references;
19. the durability compatibility matrix rejects mismatches, volatile status
    makes no restart claim, and persistent recovery restores queue/display
    state, strong references, outcomes, and cursors; volatile Console restart
    over persistent subsystems enumerates and retires every abandoned gateway
    process generation's strong references; and
20. browser and CLI clients produce the same normalized requests, statuses,
    cancellation outcomes, errors, and idempotency results while ingress and
    egress remain separate Extension process sessions.

The portable suite uses a fake Core/media/gateway, injectable clocks and IDs,
bounded stores, deterministic collectors, and real protocol framing. In
addition, acceptance requires an integration suite against the actual
`persistent` Core, media, and gateway stores. It MUST terminate the process
at the handoff points above, restart a fresh process, query the Module job outcome,
run the real collector, and verify records, bytes, strong references, Blocks, Deliveries,
cursors, and absence of duplicates. Throwing an exception inside one process is
not sufficient evidence for restart recovery.

Neither suite requires an owner endpoint, OSS account, model, API key, internet
access, or paid service. Optional live storage tests remain separate.

### 15.2 Media

Media acceptance MUST cover text-only, image-only, audio-only, video-only, and
mixed inputs; file selection, drop, and paste; streaming limits; MIME spoofing;
partial upload failure; cancellation; active I/O to upload-grant strong
reference, upload-grant to queued-message strong reference, and queue strong
reference to committed Block/Page handoffs; finite grant reuse; per-session
display handoff strong references; active display grant/acknowledgement races;
expired grants; unauthorized cross-session asset reuse; transformed image
views; private output resolution; and unsupported media fallback.

No test may pass merely because a URL string was produced. Render tests MUST
verify nonblank image pixels or playable media metadata from deterministic fake
assets without disclosing a path or storage credential.

### 15.3 Security

Security tests MUST verify authentication on every private operation, exact
tenant/session/route authorization, CSRF rejection, hostile/absent Origin on
WebSocket upgrade, pairing-code expiry and single use, rate and body limits,
upload streaming limits before buffering, session revocation, and secret and log
redaction.

They MUST also verify frozen shared-route membership, revocation between prepare
and display read, static Page topology under route replacement, rejection of
queue/display capability handles and Core leases at the external protocol,
reserved-schema publisher enforcement, and proof that the Console injects no
session, route, message, Module job, Delivery, Page, ingress message record, or
capability identifiers into canonical Block metadata or ordinary logs. User
text containing ID-like strings MUST remain unchanged, inert, and unable to
recover ingress message record authority.

An adversarial corpus MUST include script/HTML/Markdown injection, dangerous URL
schemes, malicious SVG, Cascading Style Sheets (CSS)-like strings,
bidirectional (bidi) or control characters, oversized Unicode, hostile
filenames, provider errors, tool arguments, malformed protocol events, and
payload strings that resemble file paths, object keys, or signed URLs. None may
execute, escape its tenant, trigger a fetch, or alter trusted UI.

### 15.4 Playwright visual and interaction acceptance

The implemented UI MUST be exercised with Playwright against deterministic fake
services at minimum at:

- 1440 x 900 and 1024 x 768 desktop/tablet viewports;
- 390 x 844 and 360 x 800 mobile viewports; and
- increased text size and one right-to-left locale.

Screenshot and interaction scenarios MUST include empty/first use, long text,
image-only submission, mixed image/audio/video output, upload progress and
failure, durable/volatile queue labels, retrying, cancel-requested,
committed-after-cancel-request, committed ingress, shared-route fan-out,
self-loop reconciliation, tool approval, outcome unknown,
disconnected/resumed, contiguous-ack rejection, backpressure, expired session,
unknown Block schema, long localization strings, and RTL layout.

Acceptance requires:

- no incoherent overlap, clipping, hidden actions, unstable resizing, or
  unintended horizontal page scroll;
- readable text and controls at every target viewport;
- composer and newest status reachable with the mobile keyboard/safe area;
- nonblank, correctly framed image/video previews with stable aspect ratios;
- working keyboard-only send, upload removal, route selection, inspection,
  approval, retry, dialog close, and focus restoration;
- useful screen-reader names/status and automated accessibility checks with no
  serious violations;
- reduced-motion behavior;
- no uncaught browser errors, CSP violations, failed asset loads, or leaked
  credential-bearing URLs; and
- screenshot baselines reviewed for both light/dark modes only if both modes are
  declared supported.

Playwright security cases MUST also prove that hostile content remains inert,
cross-session API/media requests are rejected, browser refresh resumes without
duplicate display, and direct navigation cannot bypass session authentication.

## 16. Migration and acceptance boundary

Adopting this Draft requires replacing any global in-memory message history,
direct WebSocket-to-Page writes, unscoped media upload, or combined source/sink
loop with the fixed-route actors, display preparation capabilities, ingress
message records, and
strong-reference handoffs above. Existing Console state has no implicit
authority to become durable conversation memory. Legacy payload fields
containing session, route, message, the old `processingId`, Delivery, or Page
identifiers MUST NOT be accepted as trusted ingress message record state;
migration needs an authenticated mapping or retains them only as inert legacy
content.

This document cannot become Accepted until the following are published and pass
the suites above: stable external protocol and ingress message record schemas;
ingress snapshot and display prepare capability schemas; the built-in
`dolly.console.message-boundary/1` registry record and renderers; the durability
validator; Module job outcome reconciliation; queue/display strong-reference
owner and retention policies; the default cancellation, shared-membership,
offline, and lossy policies; separate Extension process packaging; and the
supported accessibility/localization matrix. The real persistent crash and
garbage-collection suite is an acceptance prerequisite. A final product rename
is not.
