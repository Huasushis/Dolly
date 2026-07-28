# ADR-0004: Deterministic scheduling as the default

Status: Proposed

Date: 2026-07-24

## Context

Adaptive interval control is an unvalidated research mechanism in the current
runtime. Fan-out feedback is order-dependent, backlog is measured globally rather
than per consumer, and the implementation violates the stated period definition.

## Proposed decision

- A module instance is a single-consumer actor. No scheduling strategy may start
  a second execution for that instance while its current generation is active.
- Reactive modules run when their inbox transitions to ready, subject to declared
  debounce/batch limits. Periodic/source modules run from a monotonic schedule.
- For a periodic module, `period` is the minimum intended start-to-start interval.
  After an execution taking `elapsed`, the next delay is
  `max(period - elapsed, 0)`, with an explicit missed-tick/coalescing policy.
- Mailboxes are bounded. Overload behavior is an explicit block, reject, coalesce,
  or spill policy; hidden interval mutation is not backpressure.
- Scheduling policy is a replaceable interface fed by per-consumer lag, age,
  bytes, deadlines, and resource budgets. The shipped default is deterministic.
- AIMD, tensity, and learned/adaptive policies remain opt-in experiments until an
  accepted ADR cites evidence collected under the experiment protocol.

## Consequences

The initial runtime favors understandable latency and failure behavior over
speculative throughput optimization. Source, reactive, and periodic intent become
explicit. Experimental schedulers remain possible without redefining delivery.

## Required conformance evidence

Tests must use a virtual/monotonic clock and cover long executions, missed ticks,
fan-out, cancellation, mailbox saturation, restart, stale reports, and stable
results independent of downstream report order.
