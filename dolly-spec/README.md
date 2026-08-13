# Dolly Specification Repository

[简体中文](README.zh-CN.md)

This repository is the implementation contract and research plan for Dolly: a
deterministic, recoverable cognitive runtime with process-isolated extensions.
It is intentionally a specification repository, not an implementation.

The normative specification is written in English. The two uploaded owner TXT
notes are preserved byte-for-byte under `docs/owner-notes/`; the owner
clarification in the HTML conversation is mechanically extracted there as a
third traceability record, the later Memory-injection clarification is
preserved as a fourth, the Extension/future-track clarification as a fifth, and
the development-order clarification as a sixth. The Chinese README exists only
as an entry point.

## Status

- Specification version: **0.1.0-draft**
- Target product milestone: **Dolly v1**
- Normative status: **pre-implementation review**
- Old weak-model export: **excluded from all decisions**

No component may claim Dolly v1 conformance until every `V1-*` requirement and
the mandatory adversarial suite pass. Research proposals are not product
guarantees.

The repository also defines two optional v1 conformance profiles—the
Two-Thirds Mean Filter and NapCatQQ Channel—and bounded research protocols for
Testament and LevelUpper. Base v1 does not require those profiles or research
features; a package that advertises one must pass its profile-specific gates.

## Start here

1. Read [the specification home](docs/index.md).
2. Read [normative conventions](docs/spec/00-governance/01-normative-conventions.md).
3. Read [architecture and frozen invariants](docs/spec/01-architecture/04-frozen-invariants.md).
4. Implement against the [reference abstract machine](docs/spec/core/07-reference-abstract-machine.md), schemas, and test vectors—not prose examples alone.
5. Map the contracts onto the [Rust reference blueprint](docs/implementation/01-rust-reference-blueprint.md) or follow the [Extension authoring guide](docs/implementation/02-extension-authoring-guide.md).
6. Use [the implementation plan](docs/spec/roadmap/01-implementation-plan.md) for product priority and convergence order.
7. Use the [work-package DAG](docs/spec/roadmap/02-work-packages.md) and [critical-path and early-use gates](docs/spec/roadmap/04-critical-path-and-early-use.md) as the authority for parallel starts and integration boundaries.

## Repository map

| Path | Purpose |
| --- | --- |
| `docs/spec/` | Normative product contract and non-normative research plan |
| `schemas/` | Machine-readable JSON Schema 2020-12 contracts |
| `protocol/examples/` | Valid and invalid wire examples |
| `test-vectors/` | Deterministic abstract-machine and failure vectors |
| `examples/` | Structurally complete resolved configuration examples |
| `docs/adrs/` | Decisions that resolve ambiguity or change observable behavior |
| `docs/baseline/` | The self-identified GPT-5.6 Pro engineering draft, retained as non-normative evidence |
| `docs/owner-notes/` | Original owner requirements, unchanged |
| `tools/` | Repository consistency checks |

## Preview and validation

The documentation is laid out as an mdBook source tree while remaining readable
on GitHub or importable into GitBook.

```bash
mdbook serve --open
python3 tools/validate_repo.py
npm ci
npm run validate
make package
```

The validator does not prove semantic correctness. It checks source-evidence
hashes, strict JSON, internal links, requirement identifiers, cross-field
examples, canonical fixture digests, and test-vector structure. The Node
validator compiles every Draft 2020-12 schema with AJV and validates all
repository instances plus negative smoke cases. The separate research-domain
gate executes the Filter, Testament, and LevelUpper cross-record arithmetic,
digest, identity, isolation, and wire semantic validators. The
reference implementation must additionally run model-based, crash-point,
protocol, security, and cross-platform tests.

Node.js 20 or newer is required by both full checks: the Python structural
validator invokes the same ECMAScript number serialization used by the Node
validator when it computes RFC 8785/JCS digests, preventing cross-language
schema-bundle hash drift.

`make package` runs both validators and writes a deterministic source archive
to `dist/dolly-spec.zip`; it does not require the directory itself to be a Git
checkout.

## Design sentence

Stable Core is responsible for never corrupting the event history; Extensions
may fail and restart; Research may explore, but may not silently alter Core
semantics.

## Contribution rule

Any change to observable behavior requires: a requirement diff, an ADR, updated
schemas, updated reference-machine vectors, and a compatibility classification.
See [CONTRIBUTING.md](CONTRIBUTING.md).
