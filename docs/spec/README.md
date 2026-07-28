# Dolly Specification Set

This directory contains the normative specification set for the Dolly takeover.
It deliberately separates stable product contracts from implementation plans and
research hypotheses.

## Authority order

When two sources disagree, use this order:

1. Directly confirmed owner requirements in
   `docs/takeover/confirmed-user-requirements.md`.
2. Accepted architecture decision records.
3. Accepted documents in this directory.
4. Conformance tests that cite an accepted contract.
5. Current implementation behavior.

Files under `.qoder/specs`, `TASK_HANDOVER.md`, existing experiments, and current
tests are historical evidence only. They are not normative and cannot override a
confirmed requirement or accepted contract.

## Document states

Every normative document must declare one of these states near its title:

- **Draft**: open to correction; implementation must not claim conformance.
- **Accepted**: reviewed decisions are binding until superseded by an
  architecture decision record.
- **Superseded**: retained for history and linked to its replacement.

Draft documents may use requirement words such as MUST, SHOULD, and MAY as
defined by Request for Comments 2119, but those requirements become binding
only after the document is accepted.

## Separation of concerns

An **Extension** is a separately packaged program that adds Dolly
functionality. A **Module** is one configured instance of an Extension. These
terms distinguish reusable program code from each configured runtime instance.
A **Block** is one immutable information unit that Modules exchange; the name
distinguishes the complete stored unit from an item in its ordered content.
A **Media** item is registered bytes and inspected metadata with one public
identity (`mediaId`). The term covers content that may not be a filesystem file
and distinguishes its identity from its storage records.

- `core-runtime.md`: Blocks, named append-only delivery logs (Pages), occurrences
  of a Block in a Page (Deliveries), Module execution, reference management, and scheduling
  contracts.
- `instance-topology.md`: the configured Page set, Module set, and connections
  inside one instance configuration revision, the equivalent command-line and
  graphical editing paths that change them, change classification and reload
  semantics, and the Extension-declared configuration an operator may edit.
- `block-payload.md`: the standard ordered Block content schema. Its content
  items are the only source of Block and Media references.
- `media.md`: the single Media identity, crop requests, storage records, strong
  references, access leases, and collection.
- `media-derivation.md`: audio segmentation and video frame extraction, where a
  derived part is a new Media identity rather than a crop-like request
  parameter, plus the external-toolchain boundary and its fail-closed rules.
- `extension-process-protocol.md`: the JavaScript Object Notation (JSON) process
  protocol used by Extensions, including process isolation, session
  authorization, protocol versions, and configuration.
- `schema-registry.md`: ownership of a content-item schema name, the reserved
  namespace, where publisher identity comes from, how a validator is pinned
  against drift, and why a naming conflict must fail before a Module starts.
- `model-provider.md`: endpoint, model, and operation support descriptions,
  provider adapters, reasoning observation, embedding, and controlled live
  test fixtures.
- `llm-extension.md`: conversation state, prompt trust, multimodal assembly,
  tools, streaming, and validated large language model (LLM) output.
- `console-extension.md`: authenticated external input and output, session
  routing, client protocol, and the browser and command-line interface (CLI)
  experience.
- `memory-extension.md`: isolated background indexing, retrieval, retention, and
  evidence gates.
- `skill-extension.md`: deterministic Agent Skills-compatible discovery and
  Module description and skill catalog publication.
- `security-operations.md`: trust boundaries, networking, background-service
  operation, interprocess communication (IPC), secrets, and operational
  recovery.
- Experiment protocols belong under `docs/experiments`, not in product specs.
- Migration plans and progress reports belong under `docs/takeover`, not here.

## Change discipline

A contract change must identify affected conformance tests and migration impact.
Research mechanisms such as adaptive scheduling, proposed load-pressure
measures, or speculative memory features remain optional experiments until
evidence and an accepted architecture decision record promote them into the
product contract.
