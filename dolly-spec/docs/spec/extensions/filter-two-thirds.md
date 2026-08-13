# Two-Thirds Mean Filter Extension Specification

Status: **normative optional Extension profile for Dolly v1**. A Dolly v1
distribution is not required to ship this Extension; an implementation that
claims this profile MUST satisfy this chapter.

The fixed Extension ID is `org.dolly.filter`; the Module type in this profile
is `two-thirds-mean-filter`.

`REQ-FILTER-001` — A conforming Filter MUST accept the stable, provider-neutral
signal Part defined here, maintain its state transactionally per trusted source,
select deterministically by the bias-corrected smoothing rule, and return at
most one newly created BlockDraft containing only the permitted projection of
the selected input.

`REQ-FILTER-002` — Source identity MUST come from Runtime-trusted Block producer
and configured-identity records. A signal value cannot name, replace, or forge
its source. A Module that has never supplied a valid signal is ineligible;
omission after a valid signal holds the prior value without decay.

`REQ-FILTER-003` — Filtering means semantic projection into a new Block, not
forwarding an existing Block identity. The projection MUST NOT copy an Action,
ActionResult, Block envelope identity, or authority-bearing research hint.

## 1. Why the signal is a JSON Part

The signal is neither provider `extra_body`, an Extension RPC method, an
Action, namespaced metadata owned by another Extension, nor a research hint.
Those carriers respectively exclude non-LLM Modules, bypass Page/Activation
semantics, create control-result traffic, violate metadata ownership, or let an
experimental carrier decide stable routing.

An upstream Module participates by placing at most one Part for a configured
channel in its ordinary BlockDraft:

```json
{
  "kind": "json",
  "schema_uri": "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json",
  "value": {
    "schema": "dolly.filter-signal/v1",
    "channel": "default",
    "score": 731
  }
}
```

The value MUST conform to `schemas/filter-signal.schema.json`. `score` is an
integer in `0..1000`; zero is a real observation. A non-LLM Module uses exactly
the same Part. The Module Descriptor premise projection SHOULD describe only
this short contract and the configured channel. It MUST NOT expand the Filter
algorithm, tracked sources, EMA history, or current mean into Premise.

The Filter validates the value against the installed schema identified by the
exact URI. Core's generic `schema_uri` field alone is not proof of validation.

## 2. Source, cohort, and observation identity

For v1, one frozen Activation Manifest is one selection cohort. The trusted
source key is:

```text
(instance_id, producer.module_id, signal_channel)
```

The Runtime, not the Part, supplies the producer. Module IDs are non-reusable
configured identities under `REQ-ID-005`; therefore an unrelated replacement
cannot inherit the old source state. Blocks with `producer.kind` other than
`module` are ineligible. A Block produced by this same Filter Module is ignored
by default, which prevents a Page self-loop from recursively voting for itself.

A source is a candidate in a cohort only when all are true:

1. the Manifest contains at least one distinct input Block from that source;
2. a current or earlier distinct Block from that source supplied one valid
   signal for the configured channel;
3. the source is not excluded by the self-source rule; and
4. the source has an eligible content Block in this Manifest that can be
   projected within all Part, Asset, depth, and byte limits.

A tracked source absent from the Manifest does not enter this cohort's mean and
does not cause an old Block to be emitted. There is no implicit round barrier:
if an application requires exactly one response from each expert, it MUST build
that barrier explicitly rather than relying on scheduler batching.

Within a Manifest, distinct Blocks are processed in canonical Delivery order.
The same Block delivered through several Pages is one observation. The durable
observation identity is `(storage_scope_id, channel, instance_id,
source_module_id, source_block_id)`; seeing
it in a later Activation does not update the EMA again. Several new Blocks from
one source update in order, but the source appears once in the mean. After all
signal updates, its content candidate is the last Block in canonical Delivery
order whose configured-channel signal is either exactly one valid value or
absent, and whose projection fits all limits. A malformed or unprojectable
Block is skipped for content selection; the scan may fall back to an earlier
eligible Block from that same Manifest. A valid score on an unprojectable Block
still updates EMA before that Block is skipped, while a malformed signal never
does. There is no fallback to a Block outside the current Manifest.

For one Block and channel:

- no matching signal holds an existing value and is ineligible for a never-seen
  source;
- exactly one valid signal updates the source;
- two matching signals, a wrong type, an out-of-range score, or malformed value
  makes that Block invalid for selection and does not update the prior state;
  malformed is not silently treated as omission; and
- signals for other channels are inert.

Malformed content produces a bounded diagnostic without rolling back unrelated
valid sources. Storage corruption, quota exhaustion, or inability to record an
observation is an Activation failure and MUST NOT advance input cursors.

## 3. Deterministic smoothing

Configuration names the parameter `new_sample_weight_ppm` to avoid the two
opposite conventions commonly called beta. Let:

```text
W = 1,000,000
R = 1,000,000
w = new_sample_weight_ppm, where 1 <= w <= W
xq = score * R
A0 = 0
Z0 = 0
```

For each new valid observation:

```text
A' = round_half_even(((W - w) * A + w * xq) / W)
Z' = round_half_even(((W - w) * Z + w * W) / W)

q_raw = round_half_even(A' * W / Z')   when bias_correction is true
q_raw = A'                             otherwise
q = clamp(q_raw, 0, 1000 * R)
```

All intermediate arithmetic MUST use checked integers wide enough for the
configured bounds; floating point is non-conforming. Missing observations do
not change `A`, `Z`, or observation count. With bias correction, the first
observation is exactly its input score at internal precision. Changing `w`
affects only observations evaluated under the new frozen configuration; it
does not rewrite prior accumulator state.

The final clamp is mandatory because `A` and `Z` are quantized separately. For
very small `w` and long constant boundary sequences, independent half-even
rounding can otherwise put their ratio a fraction outside the mathematical
convex hull (for example, produce a normalized score of 1001 from only 1000
samples). Saturation is applied before the value enters candidate state,
selection, a decision record, or the normalized signal; it is not an optional
provider adapter correction.

For `n` eligible sources with corrected values `q_i` and `S = sum(q_i)`, the
winner minimizes:

```text
distance_i = abs(3 * n * q_i - 2 * S)
```

This is exactly the distance to two-thirds of the cohort mean without division.
Equal distances are resolved by ascending bytewise comparison of
`UTF8(JCS([instance_id, producer.module_id, signal_channel]))`; array order and
JCS string escaping are part of the contract, so concatenation with an
implementation-defined delimiter is non-conforming. Input completion order,
wall time, random values, and process scheduling MUST NOT break ties. One
candidate selects itself; zero candidates returns no BlockDraft while
successfully consuming well-formed input.

## 4. Projection and nested Filters

The output is a new `BlockDraft`. Core assigns a new Block ID, producer, time,
trace, Action IDs, and digests. The Filter MUST NOT call `host.ingress.submit`
for Activation output and MUST NOT append directly to a Page.

The default projection:

- copies the bounded description;
- copies Text and authorized Asset Parts in original order;
- copies a BlockRef only when configuration explicitly permits portable
  semantic references and the ordinary Core reference rules still pass;
- copies no input JsonPart in v1. A URI alone does not bind schema bytes or a
  transform revision, so a URI allowlist would permit schema drift. Text and
  Asset Parts are the v1 portable content surface;
- removes every Part whose `schema_uri` is the Filter signal schema, including
  signals for other channels, then appends exactly one normalized signal for
  this channel whose score is `round_half_even(q / R)` and therefore lies in
  `0..1000`;
- emits no Actions;
- emits no research hints; and
- emits the output Block with empty metadata in v1 and never copies producer
  metadata. The selection receipt exists only in the Filter decision ledger
  and authorized diagnostics; it is not downstream Block metadata. An
  Extension cannot write or reproduce another Extension's metadata namespace
  merely because configuration names it.

The selected source's Action cannot be copied as a new ActionDraft: doing so
would assign a new Action ID and might repeat a message, tool call, moderation
operation, or payment. An `ActionResult` cannot be detached from its original
Action and reused as a new result.

Nested Filters are ordinary Modules:

```text
source -> Filter A (new Block) -> Filter B (new Block)
```

Filter B sees Filter A as the immediate trusted source. It does not impersonate
the original producer. The one normalized signal permits composition without a
growing forward wrapper. A receipt MAY identify the selected input in private
state or authorized diagnostics, but it grants no downstream authority.

Core trace construction still depends on every Manifest input used to compute
the mean, not only the winner. Therefore “discard” means “do not copy semantic
content downstream”; it does not delete inputs or permit false lineage. The
current maximum of 16 independent root traces bounds a Filter cohort. A Filter
MUST surface the ordinary Core limit rather than claim dependency only on the
winner.

## 5. Durable state and Activation commit

The Module Descriptor MUST request:

```text
mode = fenced_replay
evidence = activation_ledger
ledger.namespace = org.dolly.filter.activation
ledger.location = module_state_directory
```

The Filter is not `pure_compute`: its EMA and exact-observation ledger are
semantic state. They are keyed by the Host-assigned `storage_scope_id`, channel,
and configured `state_epoch`. An Activation is processed as a two-phase
Extension-local decision:

1. read committed state and compute all updates and the output;
2. durably record a prepared decision keyed by `(activation_id,
   manifest_digest)`, including the frozen config/schema/algorithm digests,
   the complete bounded before/after accumulator states and their digests,
   ordered trusted observation tuples, unique
   sorted candidate tuples, selected trusted `(instance_id,module_id,Block)`
   tuple, and the complete canonical
   Activation payload bytes plus digest (or an immutable retained blob of
   those exact bytes);
3. return the recorded result only after that record is durable;
4. query `host.activation.status` after an ambiguous interruption;
5. promote the state exactly once when Core committed; or discard it when Core
   authoritatively did not apply the Activation.

A redispatch of the same Activation returns the retained canonical bytes—it
does not reread the selected input, re-run projection, or apply observations
twice. The ledger semantic validator requires each candidate source tuple to be
unique and canonically sorted, the selected `(source,Block)` to be exactly one
candidate (or all three instance/source/Block selection fields null), and every corrected value, sum,
distance, and output digest to match the fixed arithmetic and retained bytes.
It starts from `before_state`, applies only `applied` observations in ascending
`manifest_ordinal` with the frozen `new_sample_weight_ppm`, and requires the
result to equal `after_state`. A `projection_eligible` observation selects the
latest eligible Block for that source but does not bypass the ordered EMA: an
oversize later valid Block can update `A/Z` while content falls back to the
earlier projectable Block. Candidates MUST be an exact projection of those
latest eligible Blocks and their replayed source states; neither `A`, `Z`, nor
`q` is accepted merely because the candidate fields are internally consistent.

Both accumulator states use unique source tuples sorted by
`UTF8(JCS([instance_id,module_id,channel,state_epoch]))`. Their digest is
`DS("dolly.filter-accumulator-state.v1", {"storage_scope_id": scope,
"channel": channel, "state_epoch": epoch, "state": complete_state})` using
`DS(label,value) = SHA256(UTF8(label) || 0x00 || uint32be(n) ||
UTF8(JCS(value)))`, where `n` is the JCS byte length. This digest
covers the arithmetic state used by selection; the separate exact-observation
ledger remains the authority for classifying an observation as `duplicate`.
Self-consistency inside the decision is not an input-reachability proof. The
validator receives the Host/ledger-authoritative `storage_scope_id`, frozen
Manifest digest, committed prior accumulator state plus digest, and the
canonical observation sequence derived from the trusted Manifest and Blocks.
For output validation it additionally receives the exact Host-trusted full
Blocks named by that sequence, their frozen Manifest envelope digests, and the
exact Asset-view and BlockRef-relation authorization sets that applied to the
Activation. It verifies each Block body/envelope digest and producer tuple,
selects the candidate's trusted Block, and deterministically reconstructs the
complete `ActivationPayload`: description only when enabled; Text, authorized
Asset, and enabled authorized BlockRef Parts in original order; no input JSON
Parts (including every Filter signal on every channel); one newly appended
normalized signal; and empty Actions, metadata, and hints. The reconstruction
must fit the frozen Part and canonical-JCS-byte budgets and byte-equal the
embedded payload. A retained `preparedOutput`, when supplied, is archival byte
evidence only; matching it and recomputing `output_digest` cannot authorize
different text, an Action, JSON, metadata, a hint, an Asset/view, or a
reference.
It requires the embedded scope, Manifest, `before_state`, and every observation
field—including score, disposition, order, and `projection_eligible`—to match
those authorities exactly before replay. A caller that cannot provide this
context, the trusted full Blocks, and their authorization context cannot
validate or promote the prepared decision. Thus an attacker
cannot replace the prior state or a score and then legitimize the change by
recomputing all decision-local digests, nor replace the projected output and
legitimize it by resealing archival bytes.
Snapshot, restore, migration, hot replacement, and
stop/restart MUST retain or explicitly migrate the accumulator and observation
ledger under the same storage scope. A full ledger MUST fail with bounded
backpressure; a probabilistic deduplicator or silent eviction cannot authorize
re-weighting an old Block.

## 6. Configuration

Resolved configuration MUST conform to `schemas/filter-config.schema.json` and
freeze at least the signal channel, sample weight, bias correction, self-source
policy, copy policy, source/observation quotas, and output limits. In v1,
`copy_json_parts`, `copy_metadata`, and `copy_research_hints` are all fixed
false. The fixed v1 semantics are Manifest-present cohorts, trusted producer
identity, JCS-bytewise tie break, and corrected-score output. A live config
update affects only new Manifests. Changing the channel or `state_epoch`
creates a distinct state namespace; it does not reinterpret another namespace's
history. Old namespaces remain governed by explicit retention/backup policy.

State headers freeze the Filter algorithm revision, `W`, `R`, and
`bias_correction`. Changing `bias_correction` on a populated channel is rejected
unless an audited config transaction selects a fresh `state_epoch`/channel or a
versioned migration explicitly resets/rebuilds the accumulators; toggling it
over the same `A/Z` is non-conforming. `new_sample_weight_ppm` may change for
future observations because each prepared record pins its applied value.

## 7. Conformance tests

Tests MUST cover first-observation correction; the `100 -> 900` beta example;
missing-value hold; zero and 1000; beta one; corrected and uncorrected modes;
very small weight plus a long constant boundary sequence and mandatory
saturation of quantization overshoot;
near ties without floating point; a three-source exact tie; never-signaled
sources; multiple Blocks per source; duplicate Page occurrences; an old Block
seen again; duplicate/malformed signals; forged source data; non-LLM sources;
self-loops; nested Filters; removal of Actions, ActionResults, metadata, and
hints; Asset and BlockRef authorization; Part/byte headroom for the appended
signal; no-candidate behavior; state quotas; frozen config races; configured ID
tombstones; every prepare/promote crash point; snapshot/restore; and the
16-independent-root Core limit. Multiple-Block cases include
`valid -> malformed`, `valid -> oversized`, and `malformed -> valid`, proving
the last-eligible fallback rule independently from EMA update order.
