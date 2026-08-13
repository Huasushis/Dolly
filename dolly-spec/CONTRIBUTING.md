# Contributing to the Dolly Specification

## Change classes

1. **Editorial** — wording or navigation only; no observable behavior changes.
2. **Compatible clarification** — removes ambiguity without invalidating a
   conforming implementation; requires tests when executable.
3. **Compatible extension** — adds an optional negotiated capability; requires
   schemas, feature discovery, and downgrade behavior.
4. **Breaking semantic change** — changes state transitions, ordering, errors,
   persistence, or security. It requires a spec-major bump and migration plan.

## Required change set

A non-editorial pull request MUST include:

- the affected `REQ-*` or `INV-*` identifiers;
- an ADR under `docs/adrs/`;
- schema and golden-vector changes where applicable;
- happy-path, boundary, retry, crash, and hostile-input tests;
- compatibility and rollback notes;
- traceability-table updates.

Normative behavior MUST NOT exist only in an example, source-code comment, UI,
or provider adapter. If prose and a machine-readable schema disagree, the
conflict resolution rules in the normative conventions apply and the conflict
is a release blocker.

## Research changes

Research work starts outside stable execution paths. A result may advance only
through `research-only -> shadow -> canary -> stable-candidate -> stable` and
must satisfy the promotion gate. A positive benchmark alone is insufficient.

