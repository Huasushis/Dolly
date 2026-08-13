# Product scope

## Product definition

Dolly is a local-first intelligent-individual runtime. A Dolly instance is a
configured directed graph of Pages and Modules. Pages durably broadcast
immutable Blocks; Modules are instances of independently versioned Extensions;
Activations are the only stable path by which Module computation changes the
graph's observable data state.

`REQ-SCOPE-001` — Dolly v1 MUST provide:

- foreground and supervised background operation;
- multiple isolated instances managed by one per-user daemon;
- durable Page/Delivery/Activation state and crash recovery;
- process-based Extensions with a versioned JSON protocol;
- transactional, revisioned configuration changes;
- typed text, image, audio, video, file, structured, and Block-reference Parts;
- Channel, LLM, Memory baseline, Skill, and Alarm reference Extensions;
- a shared Model Gateway and secret boundary;
- CLI and local Web administration;
- Linux and Windows support;
- replayable logs, metrics, traces, backup, and migration;
- reproducible research harnesses separated from stable behavior.

`REQ-SCOPE-003` — The Two-Thirds Mean Filter and NapCatQQ Channel are optional
v1 conformance profiles. A base Dolly v1 implementation MAY omit them. A
distribution that advertises either profile MUST implement its complete
normative contract and profile acceptance tests; partial support MUST be named
as non-conforming experimental behavior.

## V1 non-goals

`REQ-SCOPE-002` — Dolly v1 MUST NOT claim or depend on:

- Rust dynamic-library hot unload;
- arbitrary Extension-provided frontend JavaScript;
- autonomous topology mutation without an authorized config transaction;
- probabilistic deletion of durable Blocks or Assets;
- causal claims inferred only from temporal co-occurrence;
- automatic Skill generation followed by immediate activation;
- production Network/LevelUpper, production Testament, or cross-instance Page
  sharing as a stable v1 guarantee;
- a general secure sandbox on platforms where none is implemented;
- exactly-once external side effects;
- deterministic LLM text generation.

The research contracts for Testament and LevelUpper make their prototypes
testable; they do not remove these non-goals or authorize either path inside a
production instance.

## Success criterion

The distinctive hypothesis—whether a macro multi-expert topology improves an
agent—does not define Core correctness. Dolly v1 is complete when the runtime
contract is reliable and the hypothesis can be tested reproducibly, even if an
experiment concludes that a simpler topology performs better.
