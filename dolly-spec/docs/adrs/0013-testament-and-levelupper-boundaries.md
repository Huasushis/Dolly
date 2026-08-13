# ADR 0013: Keep Testament replay and LevelUpper transport outside Core identity

- Status: Accepted for research architecture
- Scope: Testament and LevelUpper future work
- Compatibility: research-only; no stable v1 execution-path change
- Affected requirements: `REQ-TESTAMENT-001` through `REQ-TESTAMENT-005`,
  `REQ-LEVELUPPER-001` through `REQ-LEVELUPPER-006`

## Context

Testament was described as an accelerated learning apparatus that can replay
recorded Module inputs to different or multiple Modules. LevelUpper was
described as a bidirectional cross-Dolly Page-sharing connection with media,
reconnect, and source aliases. Treating either as direct reuse of live Core
objects would leak IDs, capabilities, mutable state, side effects, and cursor
semantics across isolation boundaries.

## Decision

Testament is an isolated research Worker. A full-clone mode binds a verified
backup, accepts no Module mapping, and uses a private authority-free copy;
portable replay imports semantic content under fresh sandbox Core identity and
explicit mappings. Recorded replay is never Activation crash retry. Corpus and
plan shape is supplemented by pure semantic validators for key/reference/split,
oracle, sandbox-isolation, per-recorded-Action policy, adapter, fixture, and
scheduler-resource bindings. Recorded Actions are closed evidence objects, and
every reachable Action has an explicit rule; a mock binds an exact non-oracle
fixture key and digest. Targets carry treatment identity so independent fan-out
is isolated while several source mappings may intentionally feed one
many-to-one treatment. Full snapshot clones are permanently limited to denied
or fixture-only networking and denied or mocked effects. Learning outputs are
quarantined typed artifacts that require separate promotion.

LevelUpper is an asynchronous content bridge over a future Host Network Broker.
Persistent config names a broker grant policy, never a bearer capability. It
uses authenticated peers and per-direction durable outbox/inbox, splits stable
portable content from occurrence/share/hop envelopes, transfers Assets, strips
remote Actions/authority, imports fresh local identity, and uses bridge
origin/path/hop metadata for loop prevention. An outbound entry becomes
sendable only after authoritative Core commit. Listener/client affects
connection establishment only.

## Alternatives rejected

- direct access to production or peer databases;
- preserving foreign Block, Asset, trace, Action, Page, or cursor identity;
- calling target Modules directly during Testament;
- treating a transport batch as one giant local Block;
- making trusted peers implicit local Action principals;
- implementing listener/TLS keys as unrestricted Extension network access.

## Consequences and rollback

Both remain explicit future work packages and do not gate Dolly v1. They gain
schemas, vectors, required research cases, budgets, and promotion gates now so
experiments do not invent incompatible semantics later. A prototype can be
deleted without migrating stable Core data. Any later stable candidate requires
its own compatibility ADR and supported Network Broker or artifact-import API.
