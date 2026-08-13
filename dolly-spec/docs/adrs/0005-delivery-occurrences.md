# ADR 0005: Delivery occurrences, not mutable Blocks

- Status: Accepted

## Decision

A Block is committed once and immutable. Each append to a Page is a distinct
Delivery occurrence. When the same Block reaches a Module through multiple
subscribed Page entries included in one frozen Activation manifest, the input
view contains one Block and an ordered occurrence list. Future arrivals are not
retroactively merged.

## Rationale

Putting `count` on a Block changes shared content depending on routing and
violates immutability. Waiting for all possible paths is impossible in a cyclic
asynchronous graph. Manifest-local occurrence aggregation preserves both
content identity and multiplicity.

