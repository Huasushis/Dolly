# Media Derivation Specification

Status: Draft

This document proposes the normative contract for producing new Media from
existing Media with an external tool: splitting an audio item into time
segments and extracting still frames from a video item. It extends
`media.md`, which owns Media identity, storage, provider access, references,
and collection. Where the two disagree, `media.md` wins.

The requirement words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY have the
meanings defined by Request for Comments 2119. Because this document is a
Draft, they describe a proposed contract and do not claim complete
implementation. Section 10 states exactly what exists today.

## 1. Decision and scope

The contract has five central rules:

1. A derived product is a **new Media identity**, not request data on the
   source Media identity. This is the opposite of an image crop, and Section 3
   explains why the two cases differ.
2. A derivation is an all-or-nothing job. Partial products are never exposed as
   a successful derivation.
3. The external toolchain is an injected boundary. When it is absent,
   unhealthy, or refuses the input, the derivation fails visibly and Dolly
   MUST NOT substitute the source, a shorter result, or a smaller part count.
4. Every derivation is bounded before dispatch by input duration, part count,
   part duration, output bytes, wall-clock time, and concurrency.
5. A derived Media item does not keep its source Media item reachable. The
   source relationship is diagnostic metadata, not a reference-graph edge.

This document covers derivation identity, the two operations, lifetime and
collection, failure and recovery, the external toolchain boundary, limits,
security, and required tests. Transcription, translation, model selection, and
prompt construction are outside its scope: those consume Media and belong to
`llm-extension.md` and `model-provider.md`.

## 2. Terms

An **identifier (ID)** is an opaque string that names one record or operation.
A configuration field ending in `Ms` expresses a duration in milliseconds.

### 2.1 Derivation

A **derivation** is one bounded transformation that reads one source Media item
and produces an ordered list of new Media items. The word derivation is used
instead of conversion or processing because the output is a distinct set of
Media identities that Dolly must register, reference, and collect on its own.

### 2.2 Derived part

A **derived part** is one output of a derivation together with its position in
the source. An audio part carries `startMs` and `endMs`; a video frame part
carries `timestampMs`. A part is not a separate kind of Media: it is an
ordinary Media item plus the ordering metadata that lets a Module reassemble
the sequence.

### 2.3 Derivation request and derivation record

A **derivation request** is the trusted-host request object naming
`derivationId`, the source Media identifier, the operation, and the operation
parameters.

A **derivation record** is the persistent identity and progress record created
for that request. It binds `derivationId` to one immutable input and to the
Media identities that were allocated for its parts, so a retry after process
exit cannot allocate a second set of parts. Its proposed schema is
`dolly.media-derivation/1` and its state is `pending`, `available`, `failed`,
`deleting`, or `deleted`.

The `derivationId` an untrusted caller supplies is an idempotency value inside
that caller's subject, not a global record identity. The trusted host derives
the internal identifier from the subject and the caller value exactly as
`media.md` Section 3 requires for a registration ID.

### 2.4 Derivation toolchain

A **derivation toolchain** is the external program that performs the
transformation, together with the host code that launches it, bounds it, and
reads its output. FFmpeg is the expected implementation. The toolchain is named
as a separate component because its presence, version, and health are
deployment facts that Dolly must probe rather than assume.

### 2.5 Derivation plan

A **derivation plan** is the list of parts a derivation intends to produce,
computed from the source metadata and the request parameters before the
toolchain runs. It exists so that part count, part duration, and total output
bytes can be rejected before any external process starts.

## 3. Identity of a derived product

A derived part MUST receive a new `mediaId`. It MUST NOT be expressed as
request data on the source Media identifier.

An image crop is request data on one identifier because the original object
still contains every pixel the crop selects: `media.md` Section 5 converts the
crop to exact pixel edges and a storage adapter encodes that exact rectangle
from the same original object at read time. Nothing new is stored, and the
inspected metadata of the original still describes the bytes.

A derived part is not like that. Its bytes do not exist in the source object:
an audio segment is a re-muxed or re-encoded stream, and a video frame is an
image in a different container and a different Multipurpose Internet Mail
Extensions (MIME) media type. It therefore has its own digest, its own byte
length, and its own inspected metadata, and `media.md` Section 3 already states
that replacing bytes creates a new Media item. Modelling a part as a crop-like
request parameter would require a second identity model with a second set of
invalid states, which Section 15 of `media.md` explicitly rejects.

Each part MUST be registered through the ordinary Media registration path in
`media.md` Section 3, so it obtains a digest, a bounded inspection, a
registration record, and a resource node like any other Media item.

Registration provenance MUST record that the bytes came from a host derivation
using the `derived` provenance class in `media.md` Section 3. An implementation
MUST fail closed rather than label a derived part with an unrelated provenance
class such as `local-file` or `provider-output`.

The derivation record additionally stores `derivedFrom`, naming the source
Media identifier and the part's position. `derivedFrom` is diagnostic data. It
is not authorization to read the source, it is not a Media reference, and
Section 5 states that it is not a reference-graph edge.

## 4. Operations

### 4.1 Audio segmentation

`audio.split` divides one audio Media item into consecutive time segments.

Parameters are either a fixed `segmentDurationMs` with an optional
`overlapMs`, or an explicit ordered list of `{ startMs, endMs }` ranges. In
both forms:

- every range MUST lie inside the inspected `durationMs` of the source;
- every range MUST have `endMs` strictly greater than `startMs`;
- explicit ranges MUST be ordered and MUST NOT overlap unless `overlapMs` is
  used, which is the only sanctioned overlap; and
- the source MUST have an inspected audio duration. A source whose duration
  could not be inspected MUST be rejected rather than probed again by the
  toolchain as an implicit fallback.

Each segment becomes one derived part with `startMs` and `endMs` copied from
the plan, not from the toolchain's report. A toolchain that returns a part
whose reported timing disagrees with the plan MUST fail the derivation.

### 4.2 Video frame extraction

`video.extractFrames` selects still images from one video Media item.

Parameters are either an ordered list of `timestampMs` values or a fixed
`intervalMs` with an optional `maxFrames`. Every timestamp MUST lie inside the
inspected duration. The output MIME media type MUST be an explicitly requested
still-image type that the bounded inspector supports; a toolchain-chosen
default MUST NOT be accepted.

Frame extraction is defined because most vision models accept still images
rather than video, so a video Media item reaches a model as an ordered set of
derived image parts plus their timestamps.

### 4.3 Operations that are deliberately absent

Transcoding, resampling, thumbnail generation, format normalization, and
concatenation are not part of this version. Each would need its own parameter
validation and its own inspection rules, and none of them is required by the
audio and video paths above. An implementation MUST reject an unknown
operation name instead of forwarding it to the toolchain.

## 5. Lifetime, references, and collection

Each derived part is an ordinary Media item with exactly one resource node, as
required by `media.md` Section 8.

While a derivation record is in `available` state it holds one strong reference
per derived part. That reference is what keeps a part reachable before any
Block refers to it. Releasing it follows the same rule as a registration
strong reference in `media.md` Section 3: release succeeds only after the
runtime proves another persistent strong-reference path still reaches that
part, and otherwise fails and restores the reference.

A derivation record MUST NOT add a reference-graph edge from a derived part to
its source Media item. Two consequences follow, and both are intended:

- collecting the source Media item does not collect the parts, because the
  parts hold their own bytes and remain independently useful; and
- a part existing does not keep the source alive, so a long-lived transcript
  segment cannot pin an entire original recording forever.

A `derivedFrom` value that names an already collected Media item is therefore
expected and legal. Readers MUST treat it as history and MUST NOT resolve it
as a live reference.

Deleting a derivation record deletes only the parts it still holds a strong
reference to, and only through the ordinary Media deletion path in `media.md`
Section 8, including its `deleting` state, idempotent adapter calls, and
visible failures.

## 6. Failure, partial products, and recovery

A derivation is all-or-nothing. It becomes `available` only after every planned
part has been registered, its bytes have passed digest validation, and the
record has been persisted. Until then no part is visible to a Block, a Module
result, or a provider access request.

The required order is:

1. validate the request, read the source metadata, and compute the derivation
   plan;
2. reject the plan if any limit in Section 8 would be exceeded;
3. persist the derivation record in `pending` state, including the plan;
4. probe the toolchain, then run it under a bounded timeout and an
   `AbortSignal`;
5. register each produced part in plan order; and
6. persist the `available` state with the ordered part identities.

A failure at any step after step 3 MUST release every part that was already
registered for that derivation, persist the record as `failed` with a stable
error code, and expose no part. An implementation MUST NOT return the parts it
managed to produce, MUST NOT shorten the plan to match what the toolchain
produced, and MUST NOT report success with a `partial` flag.

A toolchain that produces a different number of parts than the plan, an empty
part, a part larger than its limit, or a part whose MIME media type is not the
requested one is a failure of the whole derivation.

Retrying with the same `derivationId` and the same input returns the same
derivation. Reusing it with different input is a conflict, exactly as for a
Media registration ID.

Startup recovery treats a `pending` derivation record as unfinished work:
because every intermediate product is host-local, the runtime can determine
its own state without asking a remote service. Recovery MUST release any part
already registered for that record and then either re-run the derivation from
the persisted plan or mark it `failed`. It MUST NOT adopt an interrupted
toolchain's output files, because a process that was killed mid-write can leave
a syntactically valid but truncated container.

Cancellation is not a partial success. A cancelled derivation follows the
failure path above.

## 7. External toolchain and fail-closed rules

The toolchain is an injected boundary with three required capabilities: probe,
run, and terminate.

`probe` MUST run before any derivation dispatches work, and its result MUST NOT
be cached across a configuration change. When the toolchain is absent, not
executable, of an unsupported version, or fails its probe, every derivation
MUST fail with a stable unavailability error code. Dolly MUST NOT:

- return the source Media item as if it were a single part;
- fall back to an unspecified in-process decoder;
- silently disable the feature and report success with zero parts; or
- defer the failure until a model call reports a confusing input error.

The toolchain runs as a child process. Its input MUST be a host-owned path or
stream that no untrusted caller chose, and every parameter MUST be passed as a
separate argument value. Untrusted text, including a caller-supplied label, a
model-generated file name, or a MIME media type hint, MUST NOT be concatenated
into a command line or a shell invocation. `security-operations.md` Section 10
already forbids letting prompt text, model responses, or Extension payloads
choose host paths and process arguments; this contract inherits that rule
without exception.

Termination MUST cover descendants. A timeout, a cancellation, or a limit
breach MUST terminate the whole process group and MUST NOT leave an orphan
transcoder holding a file handle or central processing unit (CPU) time.

Output files are host-owned temporary files under a host-chosen directory.
They MUST be removed after registration or failure, and a failure to remove
them MUST be visible rather than silent, because they contain original user
media.

Because outputs are local, a timeout after dispatch is a knowable state, unlike
the remote storage case in `media.md` Section 9. The runtime terminates the
toolchain, discards the output directory, and records a definite failure. It
MUST NOT invent an unknown outcome state for a local child process.

## 8. Limits

Every derivation is bounded by configuration. The proposed required limits are:

| Limit | Meaning |
| --- | --- |
| `maxSourceDurationMs` | Longest inspected source a derivation accepts |
| `maxParts` | Most parts one derivation may plan |
| `maxPartDurationMs` | Longest single audio segment |
| `maxPartBytes` | Largest single derived part |
| `maxTotalOutputBytes` | Largest total output for one derivation |
| `maxWallClockMs` | Bound on one toolchain run, including start-up |
| `maxConcurrentDerivations` | Runtime-wide concurrent derivation limit |

`maxSourceDurationMs`, `maxParts`, and `maxPartDurationMs` are checked against
the plan before the toolchain starts, so an unreasonable request costs no
external work. `maxPartBytes` and `maxTotalOutputBytes` are additionally
enforced while output is read, because a plan cannot predict encoded size.
Exceeding a limit during the run is a failure of the whole derivation under
Section 6, not a truncated success.

A derived part is subject to the ordinary Media admission limits in `media.md`
Section 12 as well. A derivation that would exceed the configured total Media
bytes fails at that boundary like any other registration.

## 9. Security requirements

Derivation is a trusted-host operation in this version. There is no Extension
capability that starts a derivation, and an Extension MUST NOT be able to
choose a source Media item by presenting a raw `mediaId`.

When a derivation capability is added later, its scope MUST be derived exactly
as `media.md` Section 4 requires for Media reads: from validated
`media-reference` items in immutable Blocks already delivered to the
authenticated Module job, bound to the instance, Extension session, Module,
delivered Block, Media identifier, operation, and limits. The parts it produces
are new Media identities that were not delivered to that job, so a Module
result that references them requires a separate host grant. The Module result
rule in `core-runtime.md` Section 9.3 rejects them by itself, and that
rejection is correct until such a grant is specified.

Media bytes, temporary output paths, toolchain command lines, and inspected
container details MUST NOT appear in operational logs, matching `media.md`
Section 11.

A derived part inherits no trust from the model or Module that asked for it.
It is inspected with the same bounded decoder and the same denied-by-default
active-format rules as any other Media item.

## 10. Current implementation status

The contract above is not implemented as a working pipeline.

What exists in `src/core/media-capability/media-derivation.ts` is the interface
and the fail-closed path only:

- the request, plan, part, and result shapes;
- plan computation and limit rejection for both operations;
- the injected toolchain boundary, with an always-unavailable toolchain as the
  default so that an unconfigured deployment fails closed;
- all-or-nothing sequencing, including release of already registered parts on
  any failure; and
- bounded wall-clock time with cancellation.

What does **not** exist:

- any real FFmpeg integration. No process is launched, no container is parsed,
  and no argument vector has been validated against a real FFmpeg build;
- persistence of the derivation record. The current skeleton is in-process
  only, so it makes no crash-recovery claim and Section 6's startup recovery is
  unimplemented;
- the `derived` provenance value required by Section 3 now exists in
  `MediaStore`, but the derivation pipeline is not wired to register parts
  through it yet;
- any Extension-facing derivation capability; and
- registration of parts through a real `MediaStore`. The pipeline calls an
  injected registrar port so that tests need neither FFmpeg nor a configured
  Media store.

Dolly MUST NOT describe audio segmentation or video frame extraction as
available until the FFmpeg integration, the derivation record persistence, and
live evidence from a real media file all exist. The `derived` provenance value
is a prerequisite that has been added; it does not by itself make derivation
available.

## 11. Required evidence

Conformance requires deterministic tests for:

1. a derived part receiving a new `mediaId`, with the source Media identifier
   unchanged and no new crop-like state on it;
2. rejection of an unknown operation name without any toolchain call;
3. plan validation for both operations: ranges outside the inspected duration,
   inverted ranges, overlapping explicit ranges, a source with no inspected
   duration, and an unsupported requested output MIME media type;
4. limit rejection before dispatch for `maxSourceDurationMs`, `maxParts`, and
   `maxPartDurationMs`, proven by the toolchain never being called;
5. limit rejection during the run for `maxPartBytes` and
   `maxTotalOutputBytes`, with every already registered part released;
6. an absent or failing toolchain probe producing a stable unavailability error
   and no registration, no partial result, and no fallback to the source;
7. a toolchain that returns fewer parts than planned, an empty part, or a
   wrong MIME media type failing the whole derivation;
8. a registration failure on part N releasing parts 1 through N minus 1;
9. timeout and cancellation terminating the run, releasing every part, and
   producing a definite failure rather than an unknown outcome;
10. idempotent retry with the same `derivationId` and input returning the same
    result, and a conflicting input being rejected; and
11. after any failure, no part being reachable from a Block, a Module result,
    or a provider access request.

Tests 1 through 9 are implementable against the current skeleton with injected
doubles. Tests 10 and 11 require the persistent derivation record and the
`MediaStore` binding described in Section 10 as unimplemented.
