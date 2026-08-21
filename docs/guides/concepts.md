# Dolly Concepts

Status: Draft

This guide explains the ideas Dolly is built from: Blocks, Pages, Deliveries,
Modules, and Module descriptions. It is written for someone who wants to
understand the system before reading a specification.

It describes the model, not the current build. Several behaviors described here
are specified and not yet running; each one says so where it appears, and
[What does not run yet](#what-does-not-run-yet) collects them in one list. The
normative contracts are [the Core runtime contract](../spec/core-runtime.md),
[the Block content format](../spec/block-payload.md), and
[the Extension process protocol](../spec/extension-process-protocol.md).

## An instance

One running Dolly is one **instance**. An instance is described by one
configuration file and owns one state directory. It contains:

- a set of **Pages**;
- a set of **Modules**; and
- the connections between them, stated as each Module's input Pages and output
  Pages.

You can run several instances on one machine. Each needs its own configuration
file, its own identity, and its own state directory. Instances do not share
Blocks, Media, or identifiers.

## Block

A **Block** is one immutable information record encoded as JavaScript Object
Notation (JSON). It is the unit that moves through the system. The name
distinguishes the whole stored record from one item inside its content.

A Block has fields the runtime owns and fields the producing Module proposes.

The runtime assigns and authenticates:

- `id`, unique for the life of the instance and never overwritten;
- `sequence`, a counter that defines the total commit order inside the instance;
- `source`, the identity of the producer, which a Module cannot self-report;
- `createdAt`, a wall-clock timestamp kept for humans and logs only.

The Module proposes:

- an optional `summary` in human-readable text; and
- a `payload`, which is a schema identifier plus the value that schema accepts.

The standard payload schema is `dolly.content/1`. Its value is an ordered list of
content items:

```json
{
  "schema": "dolly.content/1",
  "value": {
    "items": [
      { "type": "text", "text": "The user asked for the build log", "format": "plain" },
      { "type": "block-reference", "blockId": "block-41" },
      { "type": "media-reference", "mediaId": "media-7" }
    ]
  }
}
```

Four item types exist: `text`, `block-reference`, `media-reference`, and `data`.
The `data` item carries structured information owned by an Extension under its
own schema identifier; the Core stores it without interpreting it.

Two consequences follow from this shape and matter in practice.

**Order is the only structure.** `items` is both the display order and the
processing order. There is no second list of references somewhere else in the
Block, so the same item that shows a reference is also what keeps the referenced
object alive.

**Only `dolly.content/1` has meaning to the Core.** If a payload uses another
schema, the Core treats it as inert JSON. It does not search it for identifiers,
web addresses, file paths, base64 data, or commands. An Extension therefore
cannot make the Core act on something by burying it in a private payload field.

`sequence` — not `createdAt` — decides ordering questions. A clock correction or
two identical timestamps never changes which Block came first, whether a
reference is legal, or the order of a retry.

### References between Blocks

A `block-reference` names one already committed Block. The referenced Block must
have a lower `sequence` than the Block being created, so the reference graph is
acyclic by construction: a Block cannot reference itself, a Block that does not
exist, or a Block created later.

A reference is not a copy. Whoever reads the Block decides whether to show a
summary, a link, or the expanded target, and how deep to expand. Because the
graph is acyclic but can still be wide and deep, any reader must set its own
limits on expansion depth, node count, and serialized size.

## Page and Delivery

A **Page** is a named broadcast connection between Modules, plus the append-only
log of what has been broadcast through it. Producers append; consumers read.

Producers and consumers are both sets, so a Page connects every producer to
every consumer. The same Page can be both an input and an output of the same
Module.

A Page stores Block identifiers, not copies of Blocks. Each append creates one
**Delivery**: one occurrence of one Block in one Page. Appending the same Block
to the same Page twice creates two Deliveries.

Each consumer of a Page keeps its own position in that log, so a slow consumer
does not hold back a fast one, and adding a consumer does not disturb the
existing ones. A new consumer must state where it starts:

- `from-head`, meaning the earliest Delivery the Page still retains;
- `from-now`, meaning only Deliveries appended after it subscribed; or
- an exact checkpoint.

There is no implicit default. `from-head` means the earliest Delivery still
retained, not a promise that collected history can be reconstructed; a
checkpoint older than what the Page retains fails visibly rather than silently
starting somewhere else.

A Module is not told which Pages other Modules are connected to. From inside a
Module, its own place in the graph is opaque: it sees input Blocks and produces
at most one output Block. The configuration, not the Module, decides where that
output goes.

## Extension and Module

An **Extension** is a separately packaged program that adds functionality. A
**Module** is one configured instance of an Extension inside one Dolly instance.

One Extension can back many Modules. They run the same code with different
configuration, different connections, and separate state. This is why the two
words are never interchangeable: the Extension is the reusable package, and the
Module is the configured thing in the graph that has an identity, a mailbox, and
a position between Pages.

Related identifiers, in the order they get narrower:

- `extensionId` names the package.
- `moduleId` names one configured Module, and is also the authenticated `source`
  of every Block that Module produces.
- `moduleGenerationId` names one initialized incarnation of that Module. Stopping
  and restarting a Module produces a new generation, and a result arriving from
  an old generation is rejected as stale.
- `moduleJobId` names one persistent unit of work: one fixed input snapshot that
  must reach a terminal result or a terminal failure.
- `runId` names one attempt at that Module job. A retry keeps `moduleJobId` and
  gets a fresh `runId`.

That last distinction is the one worth remembering. The Module job is the work;
the Run is the attempt. Retry counting, deduplication, and recovery all key off
the Module job, while cancellation and fencing key off the Run.

## How one Module action works

This is the central rule of the whole system.

When a Module becomes eligible, the runtime collects **every** Delivery pending
for it across **all** of its input Pages, orders them by the instance-wide
commit order, and hands them over as **one batch**. The Module processes that
batch as a single unit and returns **either no Block or exactly one Block**. If
it returns a Block, the runtime assigns the identity fields and broadcasts that
same Block through **every** configured output Page — one Delivery per Page.

A small example. Suppose `summarizer` has input Pages `chat` and `events`, and
one output Page `digest`:

1. Three Blocks are appended to `chat` and one to `events`.
2. `summarizer` becomes eligible. All four Deliveries are claimed as one batch,
   ordered by commit order across both Pages — not `chat` first and then
   `events`.
3. `summarizer` reads all four and returns one Block.
4. That Block is appended to `digest`, producing one Delivery there, and the
   four input Deliveries are acknowledged together with it.

Ordering across Pages is by the instance-wide sequence. Concatenating one Page
after another is wrong and the contract rejects it.

### The batch is fixed once it is claimed

The claimed batch is a snapshot. A Delivery that arrives while the Module is
running is **not** added to the batch in flight and is **not** dropped. It waits
for a later action. This is what makes a Module action reproducible: the same
Module job always has the same input, including on retry.

If the batch would exceed the configured claim limits, the runtime does not
sample, reorder, or truncate arbitrarily. It claims the largest deterministic
ordered prefix that fits and sets `hasMore: true` so the Module knows more input
is waiting. The next action continues from exactly where that prefix ended.

### One Module never runs twice at once

One Module is absolutely serial: at most one action for one Module generation is
active at any moment. That holds across normal scheduling, manual triggers,
timeouts, configuration reload, stop and restart, and recovery after a crash.

Different Modules may run at the same time. A timeout does not release the
serialization guarantee while the old code may still be executing — otherwise a
"timed out" action and its replacement could both be running.

### The same Block arriving twice

If one Block reaches a Module through two different Pages in the same batch, the
Module does not receive two copies. The runtime groups the Deliveries that name
the same Block into one group and reports how many times it occurred:

```json
{
  "block": { "id": "block-41", "...": "..." },
  "deliveryIds": ["delivery-9", "delivery-12"],
  "occurrenceCount": 2,
  "firstGlobalSequence": "1204",
  "lastGlobalSequence": "1209"
}
```

The occurrence count is delivery information, not part of the Block. The same
immutable Block can have an occurrence count of 2 for one Module and 1 for
another, so writing that count into the Block itself would be wrong. Retry
attempts, consumer progress, and delivery timestamps are excluded from Blocks
for the same reason.

## Module descriptions

Every Module may publish two short pieces of text:

- an **input description**: what input or methods it recognizes; and
- an **output description**: what output it may produce.

When the runtime invokes a Module, it supplies the output descriptions of the
producers on that Module's input Pages and the input descriptions of the
consumers on its output Pages. So a Module learns what its neighbors accept and
emit without being given the graph or the ability to call them.

The point is composition without coupling. A Module that drives a large language
model can tell the model what the surrounding Modules understand, and the
Modules stay independently configurable.

Two properties are easy to miss:

**A description is data, not authorization.** Text published by a Module is
untrusted. It does not become a system prompt, a permission, or trusted markup
merely because a Module published it. Promoting fixed reviewed text to a trusted
prompt is a separate operator decision; an Extension cannot promote its own.

**Descriptions are revisioned and updated through results.** A Module proposes
replacement text as part of its ordinary serialized result, so an update cannot
race with an action. The runtime assigns the revision, and a stale generation
cannot update anything.

The project owner's original notes call this a "premise". The contracts use
"description" because that is what the field is: bounded descriptive text about
input and output. The word "premise" carries an implication of logical
precondition that does not apply.

## Media

**Media** is registered bytes plus inspected metadata — an image, an audio file,
a video — with one identity, `mediaId`, inside one instance.

The rule that shapes everything else: after ingestion there is exactly one
identity per Media item, and Blocks carry only that identity. A Module never
puts raw base64, a local path, or a web address into a committed Block. Those
representations may appear at ingestion; what gets stored is the identifier.

A **crop** is a logical rectangle over an existing image, written next to the
`mediaId` in the referencing item:

```json
{
  "type": "media-reference",
  "mediaId": "media-7",
  "crop": { "kind": "image_rect_v1", "x0": 100000, "y0": 200000, "x1": 900000, "y1": 800000 }
}
```

A crop is a closed `image_rect_v1` value whose coordinates are fixed-point
integers on a `0..=1_000_000` grid of upright display space (`x0 < x1`,
`y0 < y1`, right and bottom edges exclusive). It is not a new Media item, not
a new identifier, and not a new stored object. It is a reference to part of the
same bytes, so referring to a region costs nothing in storage.

Crops narrow, never widen. When a Module produces a Block, each Media reference
in its output must reuse a reference it actually received. If every delivered
reference for that Media had a crop, the output must stay inside one of those
crops: it cannot restore the full image, enlarge a crop, or merge two separate
crops into a larger region. If at least one delivered reference had no crop, the
output may use the full Media or any valid crop of it. A Module cannot widen its
own view by asking for a bigger rectangle than it was given.

## How Blocks and Media stay alive

Dolly uses ordinary strong-reference semantics rather than manual counting. A
persistent record-to-target reference keeps the target — and everything the
target transitively depends on — reachable until that record releases it.
Collection becomes possible only after every strong reference and every
temporary access lease is gone.

An **access lease** is a temporary strong reference with its own identity and
optional expiry. It keeps something alive across asynchronous work without
creating a permanent record.

Recording the same owner and the same target twice is idempotent: it is a set
membership, not a counter that can be incremented twice and decremented once.

## When a Module runs

Three activation modes are defined. **Only reactive activation is specified for
the first runtime; periodic and source activation are rejected.**

**Reactive** — the Module becomes eligible when at least one input Delivery is
pending. The runtime may coalesce arrivals within configured bounds, but it never
invokes a Module with empty input just because a timer fired.

**Periodic** (specified, rejected today) — the Module runs on a target period
measured start to start, not as a delay after the previous action finishes. If an
action takes `elapsed`, the next wait is `max(period - elapsed, 0)`. When an
action overruns its period the next one becomes eligible as soon as the Module is
idle; the runtime does not fire a burst of catch-up actions for every missed
period, and it counts the misses as an observable metric.

**Source** (specified, rejected today) — the Module has no input Pages and is
activated by an external or scheduled request carrying an idempotency key.

Periodic and source activation are rejected rather than approximated because the
current commit path defines when an action is finished in terms of acknowledging
a Delivery Claim. Supporting an activation mode with no input would require
fabricating an empty batch to acknowledge, which would make "this work completed"
mean something different from what it means today.

All durations, deadlines, and periods use a monotonic clock. Wall-clock time is
recorded for humans and never drives correctness.

## Scheduling

The scheduler decides *when* an eligible Module may run. It cannot decide
*whether* a result is valid.

A scheduling policy may not start a second action for a busy Module, acknowledge
or modify Deliveries, release a reference, bypass a mailbox limit, accept a stale
result, or change a Module generation. Those belong to the runtime, which means a
scheduling change can make the system faster or slower but cannot make it
incorrect.

The current policy is a fixed deterministic one. The owner's original notes
propose an adaptive scheme modeled on additive increase / multiplicative decrease
(AIMD), the congestion-control approach used by the Transmission Control Protocol
(TCP): measure how much input each Module faces and slow its upstream producers
when it falls behind. That remains a research hypothesis and must not become a
default before controlled experiments support it. See
[the open research questions](../research/open-research-questions.md).

## What does not run yet

Everything above describes the model. The current build stops well short of it,
and the parts that are missing are the parts that would execute your code.

- **Configured Modules are refused at startup.** An instance whose configuration
  lists any Module fails to start with `RUNTIME_MODULE_MIGRATION_REQUIRED`. So
  no Module action, batching, description exchange, or broadcast happens in a
  running instance today. This is deliberate: the isolated process runtime that
  would contain Extension code is not finished, and starting Modules without it
  would be worse than not starting them.
- **Periodic and source activation are rejected**, as described above.
- **Module descriptions, retention changes, and the running scheduler are
  specified, not built.** The result contract rejects description and retention
  fields until their durable records exist.
- **Extensions cannot read Media.** The rules above are enforced by the Core on
  Module results; the capability that would let an isolated Extension fetch bytes
  or request a crop is specified and not wired.

The pieces that do exist and are tested are the immutable Block store, Pages and
Deliveries with claims and acknowledgement, retry and dead-letter handling,
strong references and access leases, Media registration and deletion with its
bytes, the Module result commit journal and its interrupted-commit recovery, and
the Extension process protocol framing, session, and capability scope checks as
component-level parts. They are not yet composed into a runtime that executes a
Module end to end.

For the current state by workstream, see
[the project roadmap](../takeover/project-roadmap.md).

## Where to go next

- [The extension developer guide](extension-developer-guide.md) — the package
  manifest, the process protocol, and what an Extension may do.
- [The Core runtime contract](../spec/core-runtime.md) — the normative rules
  behind this guide.
- [The Block content format](../spec/block-payload.md) — every content item and
  validation rule.
- [The instance topology contract](../spec/instance-topology.md) — how Pages,
  Modules, and connections are configured and changed.
