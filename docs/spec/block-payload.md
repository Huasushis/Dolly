# Block Content

Status: Draft

This document defines the one standard content format used by a Dolly Block.
It is intentionally small. A content item is one ordered piece of text, one
reference to an earlier Block, one reference to registered media, or structured
data owned by an extension.

The runtime stores the content under `payload`. `payload.schema` selects the
validator and `payload.value` is the value accepted by that validator. Only
`dolly.content/1` has Core meaning. An unknown schema is inert JavaScript
Object Notation (JSON): the Core does not search it for IDs, uniform resource
locators (URLs), paths, base64, commands, or references.

## 1. Standard value

```json
{
  "payload": {
    "schema": "dolly.content/1",
    "value": {
      "items": [
        { "type": "text", "text": "The answer", "format": "plain" },
        { "type": "block-reference", "blockId": "block-1" },
        {
          "type": "media-reference",
          "mediaId": "media-1",
          "crop": {
            "topLeft": { "x": 0.1, "y": 0.2 },
            "bottomRight": { "x": 0.9, "y": 0.8 }
          }
        }
      ]
    }
  }
}
```

`items` is the display and processing order. There is no second list of
references outside `items`. Consequently the same JSON item both shows a
reference and keeps the referenced object reachable through the Block's
dependency edge in the reference graph.

## 2. Content items

```typescript
interface BlockContentV1 {
  items: readonly BlockContentItemV1[];
}

type BlockContentItemV1 =
  | TextItemV1
  | BlockReferenceItemV1
  | MediaReferenceItemV1
  | DataItemV1;

interface TextItemV1 {
  type: "text";
  text: string;
  format?: "plain" | "markdown";
}

interface BlockReferenceItemV1 {
  type: "block-reference";
  blockId: string;
}

interface MediaReferenceItemV1 {
  type: "media-reference";
  mediaId: string;
  crop?: Rect;
  caption?: string;
  accessibility?: {
    decorative?: boolean;
    description?: string;
    transcript?: string;
    language?: string;
  };
}

interface DataItemV1 {
  type: "data";
  schema: string;
  value: JsonValue;
}
```

`block-reference` identifies one already committed earlier Block. It is not a
copy of that Block and it does not grant access outside the normal Module
permissions. The renderer decides whether to show a summary, link, or expanded
view; that display choice is not stored in the Core reference.

For a Module result tied to a Delivery Claim, an output `block-reference` may
name only a Block delivered directly in that Claim. A Block mentioned by an
input Block's own `block-reference`, or reachable through further references,
is not itself a direct input and may not be forwarded as a separate result
reference. Core applies this result rule before writing its `prepared` record
and again before recovery. It is separate from ordinary Block-reference
validation, which is still performed for every commit.

`media-reference` identifies one registered Media by `mediaId`. A Media is the
normalized original byte sequence and its inspected metadata. A crop is a
logical request for a rectangular part of an image; it is not a new Media ID,
not a new resource node, and not an object-store key. Layout is a renderer
decision, so the Core does not store inline, block, or attachment modes.

`mediaId` is a Core-managed identifier shared only within one Dolly instance,
which lets an immutable Block preserve the same Media reference across Modules.
It is not an Extension capability: an untrusted Extension can access bytes or a
crop only through host authorization derived from a matching Media reference in
a Block already delivered to its Module job. The current Extension process host
does not yet wire that authorization, so a raw identifier MUST NOT be accepted
as an Extension Media read request.

For a Module result submitted under a Delivery Claim, Core applies an additional
result check before it persists a `prepared` Module result commit record. The result
source must identify the Claim's consumer Module. Each output
`block-reference` must identify a Block delivered directly in that Claim; a
Block merely referenced by an input Block does not qualify. Each output
`media-reference` must reuse a reference found in an input Block of that Claim.
An input without a crop permits the full Media or a valid crop. When every
input reference for the Media has a crop, an output must have a crop contained
in one delivered crop; it cannot restore the full image, enlarge a crop, or
join separate crops. Core repeats this check before recovering a `prepared`
record. This does not authorize an Extension to read Media, upload new Media,
or use another grant issued by trusted Core in its result.

This additional result check does not apply to a trusted Core direct Block
commit. Such a commit still performs the ordinary content, Block-reference,
and Media validation in this document.

`data` is for extension-owned structured information. The Core does not execute
it or treat fields inside it as references.

Three separate questions are easy to conflate here, so this document answers
them separately.

*Who may use a schema name.* The Core decides, never the producer. A reserved
name may be produced only by the publisher the deployment named for it, and a
submission from any other source is rejected before the Block is created. A
producing extension asserting its own eligibility would be no check at all.

*Whether the value is checked against that schema.* Only when the Core holds a
validator pinned to the name. Where it does, the Core runs that validator
itself. Where it does not, the value is opaque to the Core.

*What an opaque value means.* Its meaning is the producing extension's concern,
and that extension is expected to have produced something its own consumers can
read. This is a statement about meaning, not a delegation of enforcement: a
consumer must not treat an opaque `data` value as having been checked by
anyone. "The Core does not interpret it" and "the producer is trusted to have
validated it" are different claims, and only the first one holds.

Every object is closed: unknown fields are rejected. `items` must be non-empty,
and every text value must be non-empty. A Module that has nothing to publish
returns no Block instead of an empty content value.

## 3. Crop coordinates

`Rect` uses normalized coordinates. Each coordinate is finite and in the range
`[0, 1]`; `topLeft.x < bottomRight.x` and `topLeft.y < bottomRight.y` are
required. Crop is currently supported only for images whose dimensions were
inspected successfully.

When a provider needs pixels, the media store converts the four coordinates
independently with nearest-integer rounding, then uses the resulting left, top,
right, and bottom edges. The resulting width and height must each be at least
one pixel and the edges must stay inside the original image. The same rule is
used by every adapter. A provider URL query parameter is an adapter detail and
must never be stored as the Media identity.

The first version does not define resize, rotation, video editing, audio
editing, point annotations, or persistent derived files.

## 4. Commit and reference rules

Before committing a Block, the Core:

1. validates the complete closed `dolly.content/1` value;
2. verifies every `block-reference` exists, is earlier in the instance
   sequence, and is not the Block being created;
3. asks the trusted media store to verify every `media-reference` and its crop;
4. builds reference-graph dependency edges from those validated items; and
5. writes the immutable Block.

Repeated content items are allowed and preserve their order. Repeating one
media or Block reference does not create duplicate dependency edges. Page
deliveries, Module retention, and Module job results hold separate strong
references; they cannot be inferred from the content array.

Raw media may be admitted only through a bounded media-ingress operation. The
current runtime does not expose that operation to Modules: it rejects direct
Module paths, URLs, and base64 fields instead of inferring an ingress request
from them. A future authenticated Module ingress operation may accept bounded
bytes, an authorized remote source, or an approved local file. Its committed
Block still contains only `mediaId` and optional crop data. Raw base64, local
paths, transient URLs, and object-store keys are never committed.

## 5. Compatibility and migration

The former top-level `refs`, `attachments`, `slot`, `relation`,
`media-placement`, and `forward-placement` fields are not part of this format.
They are rejected rather than interpreted alongside `items`, because accepting
both would create two possible sources of reference truth. The Block and Block
store snapshot schema versions are therefore `dolly.block/2` and
`dolly.block-store/3`; version 2 and older snapshots require an explicit offline migration
and are not silently loaded.

## 6. Required tests

Conformance tests must cover:

- closed-object and unknown-item rejection;
- empty content, invalid text, invalid identifiers, and invalid crop bounds;
- missing, self, future, and cyclic Block references;
- missing media, non-image crop, zero-pixel crop, and repeated media items;
- Module result source mismatch, an output Media reference absent from the
  Claim input, valid reuse of an uncropped input, and a valid sub-crop of one
  cropped input;
- an output Block reference to an earlier undelivered Block or a Block nested
  inside an input reference, direct input Block-reference success, and the
  same Block-reference checks before a `prepared` record is recovered;
- rejection of a Module result that restores the full image, enlarges a crop,
  or combines separate cropped inputs; repetition of those checks before a
  `prepared` result record is recovered; and a trusted Core direct Block commit
  that remains outside this Module result restriction;
- proof that reference-graph dependency edges come only from valid content items;
- proof that unknown payload schemas containing URL-like or media-like keys are
  inert;
- immutable records and snapshot rejection for the old schema versions; and
- provider requests that render an image crop without creating a second Media
  or object-store key.
