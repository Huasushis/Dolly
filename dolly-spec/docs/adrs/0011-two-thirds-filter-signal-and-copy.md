# ADR 0011: Carry Filter scores as JSON Parts and project a new inert Block

- Status: Accepted
- Scope: optional `org.dolly.filter` two-thirds mean profile
- Compatibility: optional Extension profile
- Affected requirements: `REQ-FILTER-001`, `REQ-FILTER-002`, `REQ-FILTER-003`

## Context

The requested Filter accepts a `0..1000` value from any kind of Module, holds a
source's prior value when omitted, smooths observations, selects the value
nearest two-thirds of the cohort mean, and sends only the selected source's
content onward. Provider `extra_body` excludes non-LLM Modules; direct methods
bypass Pages; an Action creates response noise; metadata is writable only by
its owning Extension; and research hints cannot decide stable routing.

Copying a committed Block or forwarding it wholesale would also reuse or
recreate Actions, ActionResults, envelope identity, and authority.

## Decision

Upstream Modules emit one schema-bound JSON Part. Source comes from the trusted
Block producer. Missing holds; never-signaled ignores; malformed present values
are diagnosed rather than treated as missing. The Extension uses integer
bias-corrected EMA and cross-multiplied distance, with a bytewise
`UTF8(JCS([instance,module,channel]))` source tie break.

The output is a fresh BlockDraft containing a safe semantic projection. It has
no Actions, ActionResults, copied envelope identity, or research hints. It
copies no input JSON or producer metadata in v1, removes every older Filter
signal, and appends one normalized score Part so nested Filters treat the inner
Filter as their immediate source. EMA and exact observation deduplication use
an activation ledger and two-phase commit.

Because the accumulator and correction weight are quantized separately, the
corrected fixed-point ratio is saturated to the mathematical input range before
selection or emission. This prevents a long boundary sequence with a very
small sample weight from producing 1001 solely through independent rounding.

## Alternatives rejected

- provider request fields: not architecture-neutral;
- mutable Premise: turns per-output data into capability description;
- targeted score Actions: token-heavy and semantically an operation rather
  than content;
- original Block forwarding or Action copying: repeats authority and external
  effects;
- floating-point EMA: permits platform-dependent ties and replay drift.

## Consequences and rollback

Participation is opt-in and stable implementations can omit the Extension.
Disabling it leaves source Blocks intact. State can be dropped only through an
audited Module reset with a new storage scope. The profile is constrained by
Core's 16-root trace limit because the mean causally depends on the complete
Manifest cohort.
