# ADR 0014: Keep installed Module activation authority upstream of execution

- Status: Accepted
- Scope: installed Linux Module startup, permission policies, restart, migration
- Compatibility: fail-closed clarification within the pre-implementation v1 draft
- Affected requirements: `REQ-ACT-002`, `REQ-ACT-003`, `REQ-ACT-004`, `REQ-ACT-005`, `INV-ACTIVATION-012`, `INV-ACTIVATION-013`, `INV-ACTIVATION-014`, `INV-ACTIVATION-015`

## Context

Dolly already freezes configuration and policy revisions in Activation state,
requires one exclusive instance owner, treats process output and acknowledgement
as downstream evidence, and requires Host-owned process fencing. Those rules do
not by themselves say how a persistent permission-policy definition selects a
live broker/tool/storage implementation after restart, or how a product service
unit candidate becomes the unforgeable Linux permission consumed by startup
recovery and installed composition.

Serializing a path, secret reference, function name, factory label, or copied
object would make data look like authority. Letting Ready, a process record, a
successful result, an acknowledgement, or record absence fill a missing premise
would reverse the established authority direction and make crash recovery an
escalation path.

## Decision

The Host persists a closed `dolly.module-activation-premises/v1` record for each
active configuration revision. Each distinct configured permission policy has
one immutable definition record and one non-secret backend-binding record with
an exact binding identifier, revision, digest, and installed-product component
origin. The installed Host registry, not JSON, resolves that record to one fresh
object-identity-branded live binding per controller generation.

The installed Linux product supplies one non-secret user-service candidate from
a verified installed component. The candidate is only an input to live systemd,
process-filesystem, reviewed-runtime, and delegated-cgroup verification. A
successful check mints one fresh activation permission and runtime binding. V1
product activation is systemd user-service only; system-service probes remain
lower-level evidence outside the v1 profile.

For executable Modules the order is platform refusal, controller-lock ownership,
current configuration claim, authoritative-store validation, exact premise
resolution, service/runtime proof, delegated-root preparation, startup recovery,
one-use handoff, installed composition, fresh generations, then Ready. Restart
revalidates persistent bytes and remints every live object. Migration installs a
complete premise record atomically with its target configuration and never
infers missing records from runtime state.

## Alternatives rejected

- Put backend paths, secret references, functions, or live handles in the policy
  record: data cannot prove that the current Host owns or registered them.
- Accept an in-memory same-label registry after restart: labels do not bind
  revision, digest, origin, controller generation, or migration history.
- Let Module configuration or environment choose the product service unit:
  either may suggest a candidate but cannot establish installed-product origin
  or current service identity.
- Mint authority from Ready, process success, result/acknowledgement, status, or
  absence: every item is downstream and may exist after stale, partial, or
  migrated state.
- Permit both system and user service modes in the v1 product profile: the
  normative deployment contract is per-user; a system profile needs its own
  reviewed installation, identity, and native conformance gate.

## Consequences and rollback

Implementations need persistent definition/binding/premise records, installed
component provenance, generation brands, and ordered crash tests before product
Module startup can be connected. Existing candidate registries, service options,
and process records are insufficient and remain useful only as lower-level test
seams.

No stable product Module activation data exists, so this is a compatible
fail-closed clarification. A rollback before implementation restores ambiguity
but cannot justify startup. After stable records exist, rollback requires an
offline migration that preserves every unresolved Activation and policy record;
silently dropping binding metadata is forbidden.

This decision alone does not authorize removal or weakening of
`RUNTIME_MODULE_MIGRATION_REQUIRED`, and it makes no global aggregate-boundedness
claim for `FileCoreStateStore` or file-backed result journals.
