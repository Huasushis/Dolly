# ADR-0001: Per-consumer at-least-once delivery

Status: Proposed

Date: 2026-07-24

## Context

The current Page cursor advances before module execution. A module exception or
process crash therefore loses input while the protocol never declares that loss.
Exactly-once execution cannot be guaranteed across arbitrary extension processes
and external side effects without distributed transactions.

## Proposed decision

- Each Page assigns a monotonic sequence to a `Delivery` that references an
  immutable Block.
- Each consumer owns a durable committed cursor and at most one ordered claim
  AccessLease. One Module instance never negotiates parallel claims.
- The default guarantee is at-least-once delivery, ordered per Page and consumer.
- A **Module job** is the persistent logical unit of work assigned to one
  Module. It binds one immutable input snapshot and eventually reaches a
  terminal result or terminal failure. Each retry creates a new execution
  attempt, called a Run, while retaining the same `moduleJobId`; the Module
  qualifier distinguishes this identity from other durable jobs such as
  feature extraction jobs in Memory.
- For a reactive Module job, a **Delivery batch** is the fixed ordered set of
  Delivery inputs. It is input data, not the Module job or commit identity.
  Every attempt receives a fresh Claim, claim token, attempt number, and
  `runId` for that same Module job and Delivery batch.
- A Claim does not commit. A successful Run ends with `ack`; failure,
  cancellation, lease expiry, or process death produces `nack`/redelivery.
- Runtime-mediated side effects use
  `(moduleJobId, stableEffectSlotOrToolCallId)` as their idempotency key. A
  changing `runId` is attempt identity and MUST NOT be the sole side-effect key.
- Retry limits and backoff are explicit configuration. Exhausted deliveries move
  to an inspectable dead-letter state; they are never silently skipped.
- Output registration and input acknowledgement must use a runtime-controlled
  **Module result commit**, meaning the recoverable commit of one Module result
  and its effects, so an extension cannot acknowledge input before its returned
  Block has been validated and durably accepted. The commit record is recovery
  state; it is not the lifecycle state of the Module job.

## Consequences

An extension may observe the same delivery more than once and must be idempotent.
The runtime gains crash recovery, auditable failures, and meaningful backlog. The
storage layer must persist claims/cursors before claiming restart guarantees.

## Required conformance evidence

Tests must cover exception, timeout, cancellation, host crash, AccessLease
expiry, duplicate acknowledgement, lost side-effect response followed by retry,
retry exhaustion, restart, and output-registration failure without losing or
prematurely committing the delivery.
