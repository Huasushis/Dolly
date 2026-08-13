# Dolly v1 Specification

> Status: `0.1.0-draft`. This text is a pre-implementation contract under
> adversarial review; it is not a claim that Dolly v1 already exists.

Dolly is a general intelligent-agent runtime whose distinctive product idea is
an endogenous, macro-scale multi-expert topology: independent Modules exchange
immutable Blocks through broadcast Pages. The v1 architecture turns that idea
into a deterministic event system with isolated Extension processes, durable
state, explicit failure semantics, and a separately governed research layer.

## What this specification freezes

- Block identity, canonical representation, references, and trust boundaries.
- Page broadcast, Delivery multiplicity, subscription cursors, and retention.
- Activation batching, ordering, leases, fencing, retry, and atomic commit.
- Process Extension framing, negotiation, lifecycle, host services, and reload.
- Configuration revisions and failure-aware update transactions.
- Asset, Model Gateway, Tool Broker, secret, observability, daemon, and
  cross-platform contracts.
- Contracts for Channel, LLM, Memory baseline, Skill, and Alarm Extensions.
- Conditional conformance profiles for the Two-Thirds Mean Filter and
  NapCatQQ Channel Extensions; neither is required in a base v1 distribution.
- A reference abstract machine, test oracles, failure matrix, and v1 gates.

## What it deliberately does not freeze

- AIMD or feedback-control scheduling.
- `tensity` semantics or probabilistic forgetting.
- automatic associative-memory graphs, procedural-memory synthesis, or
  persistent personality rewriting.
- autonomous topology evolution, production Testament, or production
  Network/LevelUpper behavior.

Testament replay and LevelUpper have bounded research contracts so that their
isolation, identity remapping, recovery, and evaluation can be falsified. Those
contracts do not make either feature a v1 product guarantee and cannot affect
stable data correctness until they pass the research promotion process.

## How to read normative text

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** carry
the meanings defined in the normative conventions. Tables and state machines
are normative unless explicitly marked informative. Diagrams explain
relationships but never override numbered requirements, schemas, or vectors.

The complete navigation is in [SUMMARY.md](SUMMARY.md).
