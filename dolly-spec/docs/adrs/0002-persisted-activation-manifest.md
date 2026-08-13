# ADR 0002: Persisted Activation manifest

- Status: Accepted
- Scope: batching, retry, and commit

## Decision

Before invoking an Extension, the Runtime persists an immutable Activation
manifest containing exact input Page ranges/occurrences, ordering, graph/config
and feature revisions, Module/process generations, limits, deadlines, and
idempotency identity. Every retry replays that manifest.

Successful Runtime effects—output Block, all output Page entries, input cursor
advancement, and Activation terminal state—commit in one SQLite transaction.

## Rationale

Clearing an in-memory buffer before work loses data on crash. Re-selecting a
batch on retry makes computation and deduplication ambiguous. A manifest gives
the reference machine a durable fact and makes crash behavior testable.

## Limits

This transaction does not include Extension-private databases, providers, or
external tools. Those use durable idempotency or expose unknown outcomes.

