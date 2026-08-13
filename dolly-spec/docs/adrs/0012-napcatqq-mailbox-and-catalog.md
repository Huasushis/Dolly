# ADR 0012: Wrap NapCatQQ as a bounded Channel mailbox with progressive catalog

- Status: Accepted
- Scope: optional NapCatQQ profile of `org.dolly.channel`
- Compatibility: optional Extension profile; no Dolly v1 distribution dependency
- Affected requirements: `REQ-NAPCAT-001` through `REQ-NAPCAT-006`

## Context

NapCat exposes a broad, changing OneBot-compatible API and event stream. Dolly's
Descriptor has a finite Action budget, Premise is a static projection, and an
LLM does not benefit from receiving every group message, heartbeat, or full API
schema in context. OneBot also lacks one durable universal event cursor/replay
contract, while sends and moderation have real unknown-outcome windows.

## Decision

NapCatQQ is a two-Module-type optional Channel profile in the
`org.dolly.channel` security boundary. One `per_extension` shared-hub Module owns
the daemon-wide account connection, actual-self-ID owner epoch, journal, general
operation/effect/import ledgers, and Host ingress. One separately scoped facade
Module exists per trusted consumer principal; its exact singleton output Page
and private hint/result Pages prevent Core broadcast from crossing principals.
The hub and facades keep distinct stable `storage_scope_id` values and
communicate only through the authenticated package-internal typed broker.

The hub journals authorized events and emits only exact, content-free,
coalesced hint Blocks. Each facade exposes fixed pull/view Actions. Common
operations remain small fixed ActionContracts with fixed argument/result
validators from the first read-only stage. Uncommon safe functionality is
progressively discovered through a pinned operation catalog and invoked through
separate query, mutation, management, and file families.

Credentials, raw packets, process control, and security-token APIs are not
ordinary Module capabilities. Group/module/account deny policy is checked at
dispatch on every surface. Media references stay in the closed mailbox segment
algebra; an explicit media Action makes the importing hub publish a private
two-Part envelope/Core-Asset ingress Block, so a facade never claims authority
over a hub-owned Asset. Outbound Asset arguments remain ordinary Core Parts.
Lost post-dispatch responses are unknown and are never blind-repeated.

A Host-owned NapCatQQ profile-admission validator closes relations that the Core
per-Action validator ABI cannot see: exact graph/placement/ingress authority,
whole input Action-set reservation, complete facade output, complete
content-free hint, and authoritative Asset/envelope relations. The generic
Action validators remain limited to one frozen Action/result. Every broker
operation, including reads and local cursor/view mutations, receives a durable
canonical-result record before reply so fenced replay is byte-stable.

## Alternatives rejected

- one Block per event: unbounded token and scheduling pressure;
- live content or groups in Premise/Descriptor updates: mutable untrusted data
  at the wrong authority level;
- one Action per upstream API: exceeds the current contract surface and forces
  all schemas into context;
- MCP inside the LLM Module: couples communication state and credentials to one
  model implementation and bypasses ordinary Extension lifecycle;
- “exactly once” claim: unsupported by the upstream event contract.
- one result-producing hub for all consumers: Core output Pages broadcast and
  cannot provide confidential directed replies;
- a facade directly referencing a hub-imported Asset: Module-scoped Asset
  authority is not transferable by copying an Asset ID; and
- relying on schema `$comment` or a per-Action validator for graph, whole-Block,
  sibling-Part, or aggregate-Action facts: those inputs are not in that ABI.

## Consequences and rollback

The profile is separately conforming and removable. Its private journal remains
the truth when a lossy signal Page drops a notification. Facade-only shutdown
does not stop the shared connection; a planned cohort stop shuts down facades
before the hub and releases the owner epoch last. Removing Modules requires an
explicit journal, operation/effect/import-ledger, Asset-ingress, and Activation
ledger retention or deletion disposition. No NapCat binary is bundled by this
decision.
