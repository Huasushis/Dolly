# Feature Specification: Systemic Architecture Refactor

**Feature Branch**: `001-systemic-architecture-refactor`
**Created**: 2026-07-04
**Status**: Draft
**Input**: User description: "Instructions for Legacy Project Reverse Engineering & Systemic Architectural Refactoring (Specification-Driven)" — reverse-engineer the current Dolly prototype's macro architecture, then synthesize it with five named refactoring requirements (process mutex, LLM output idempotency, MCP Roots compliance, agent-skill spec alignment, dual-mode memory) plus a unified Block/atom JSON schema, a cascade-cooldown "sleep" primitive, and open-ended architectural brainstorming.

> **Companion document**: [`tech-spec.md`](./tech-spec.md) carries the full technical
> substance (data models, algorithms, protocol details, code-level citations) per the
> project constitution's Spec Rules. This document defines WHAT is needed and WHY, per
> `/speckit-specify`'s standard template; `tech-spec.md` is authoritative for
> implementation detail, this document is authoritative for scope and acceptance framing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Process Singleton Mutex (Priority: P1)

As the operator of a Dolly Profile, I need the system to refuse to start a second instance
against a Profile that is already running, so that concurrent writes from two processes can
never corrupt that Profile's persisted state.

**Why this priority**: This is a data-corruption bug, not a missing feature — it can silently
destroy a Profile's context today. It is independent of every other story and must land first.

**Independent Test**: With one instance of a Profile already running (foreground or daemon),
attempt to start a second instance of the same Profile and confirm it is rejected without
affecting the first instance; separately, kill a running instance uncleanly and confirm the
next start succeeds despite the leftover lock artifact.

**Acceptance Scenarios**:

1. **Given** a Profile is already running as a background daemon, **When** the operator runs
   the start command again for the same Profile, **Then** the second attempt exits with a clear
   error naming the Profile and the running process, and the first instance keeps running
   unaffected.
2. **Given** a Profile is already running in the foreground, **When** the operator attempts to
   start the same Profile as a background daemon (or vice versa), **Then** the second attempt is
   equally rejected — the guard applies regardless of which entry point either instance used.
3. **Given** a Profile's process previously terminated without cleaning up its lock, **When**
   the operator starts that Profile again, **Then** the stale lock is detected and reclaimed
   automatically and the start succeeds.

---

### User Story 2 - Unified Block/Atom Data Schema (Priority: P1)

As a module developer extending Dolly, I need every unit of context ("Block") to carry a
strictly typed, validated array of content instead of an unstructured flat string, so that my
module can reliably parse what happened without brittle text scanning, and so the system can
enforce which modules are allowed to see internal-reasoning content versus external-world
content.

**Why this priority**: Every other story (idempotency, memory active-invocation, skill
alignment) depends on structured, typed content to key off. Without this, each new capability
would invent its own ad-hoc parsing convention, compounding today's fragility.

**Independent Test**: Construct a Block containing a batch of typed content entries (a
reasoning-trace entry, a tool-invocation entry, and a pruning-command entry); confirm each
built-in listener correctly recognizes only the entry types it is supposed to react to, and
ignores the rest without erroring.

**Acceptance Scenarios**:

1. **Given** a Block of internal type containing a reasoning-trace entry followed by two
   tool-invocation entries, **When** the system processes it, **Then** both tool invocations are
   recognized and dispatched, in order, within the same processing round.
2. **Given** a Block containing a pruning-command entry that references a nonexistent target,
   **When** the system processes it, **Then** the command is silently ignored rather than
   raising an error.
3. **Given** an existing Profile whose saved state still stores old-format (flat string) content,
   **When** the system loads it after the upgrade, **Then** the content is transparently upgraded
   in memory and the system continues operating without data loss or a crash.

---

### User Story 3 - LLM Recursive Tool-Call Idempotency (Priority: P2)

As the operator, I need the system to detect when the reasoning module is repeatedly issuing
the identical tool call, and automatically suppress further repeats with a clear explanation
surfaced back to it, so that a hallucination loop cannot spin indefinitely or rack up redundant
external side effects (API calls, file writes, etc.).

**Why this priority**: A real operational pain point (loops observed in practice), but it
depends on User Story 2's typed content existing first (there is no reliable call signature to
compare without it).

**Independent Test**: Simulate four consecutive identical tool-invocation requests within one
reasoning session and confirm the fourth is suppressed with an explanatory notice injected in
its place, while the first three execute normally.

**Acceptance Scenarios**:

1. **Given** the reasoning module issues the same tool call with identical parameters three
   times in a row, **When** each is processed, **Then** all three execute normally.
2. **Given** a fourth identical call follows, **When** it is processed, **Then** it is suppressed
   and an explanatory notice is injected instead of a fifth external side effect occurring.
3. **Given** the suppression notice has been delivered, **When** the reasoning module issues a
   *different* tool call afterward, **Then** it executes normally — suppression is scoped to the
   repeated signature, not a global freeze.

---

### User Story 4 - MCP Roots Capability Compliance (Priority: P2)

As the operator, I need the MCP client to properly declare and negotiate the Roots capability
during connection handshake, so that connected tool servers receive an accurate, protocol-
compliant set of allowed directories instead of relying on a startup-argument fallback, and the
recurring runtime warning disappears.

**Why this priority**: A real, currently-visible compliance gap with an existing spec, but
cosmetic/robustness in nature relative to the P1 correctness issues above.

**Independent Test**: Connect to a Roots-aware MCP server with the refactored client and confirm
no capability-mismatch warning appears in the runtime log, and the server-side root list matches
the configured project directories exactly.

**Acceptance Scenarios**:

1. **Given** the client is configured with one or more project root directories, **When** it
   connects to an MCP server that requests the root list, **Then** the server receives an
   accurate, protocol-compliant response and no "does not support MCP Roots" warning is logged.
2. **Given** the configured root directories change and are reloaded, **When** a change
   notification is sent, **Then** already-connected servers that requested updates receive the
   new list without needing a full reconnect.

---

### User Story 5 - Agent-Skill Specification Alignment (Priority: P2)

As a skill author, I need to write skills using the open, industry-standard skill format
(structured frontmatter, progressive-disclosure resource files, tool-access restrictions), so
that skills I write for Dolly are portable, and skills I already have from other tools work here
with minimal changes.

**Why this priority**: High leverage for ecosystem compatibility, but not a correctness/data-
safety issue like Stories 1-3, and can proceed independently once typed content (Story 2) is
available for its own invocation path.

**Independent Test**: Author a skill using the standard specification's full frontmatter fields
and a resource subdirectory; confirm it is discovered, its metadata loads by default while its
full body and resources load only when the skill actually triggers, and its declared tool
restrictions are enforced while it is active.

**Acceptance Scenarios**:

1. **Given** a skill directory conforming to the standard specification exists in a recognized
   skill location, **When** the system starts, **Then** the skill's name and description are
   available to the reasoning module without loading its full body.
2. **Given** that skill is triggered, **When** it activates, **Then** its full instructions load
   and any resource files it references are available on request rather than being preloaded.
3. **Given** the skill declares a restricted set of allowed tools, **When** it is active,
   **Then** tool invocations outside that set are not available for use.

---

### User Story 6 - Memory Active Invocation (Priority: P3)

As a module developer, I need to explicitly ask the memory subsystem to recall, search, or prune
historical entries on demand, rather than only ever passively observing what memory chooses to
log, so that other modules (including the reasoning module itself) can pull exactly the context
they need at the moment they need it.

**Why this priority**: A genuine capability gap, but the passive logging path already functions
today and nothing else strictly depends on this landing first — safe to sequence last among the
five named issues.

**Independent Test**: From outside the memory module, issue an explicit recall request and
confirm a correlated result is returned within the same interaction; issue an explicit prune
request for a specific entry and confirm it no longer appears in a subsequent recall.

**Acceptance Scenarios**:

1. **Given** memory holds prior entries relevant to a query, **When** another module issues an
   explicit recall request, **Then** a correlated response containing the relevant entries is
   delivered back to the requester.
2. **Given** a specific memory entry should no longer be retained, **When** a prune request
   targeting it is issued, **Then** the entry is removed and no longer appears in future recalls.
3. **Given** memory continues to passively observe ordinary activity, **When** the active-
   invocation feature is exercised, **Then** passive logging continues unaffected — the two modes
   coexist.

---

### User Story 7 - Cascade Cooldown ("Sleep") Primitive (Priority: P3)

As a module developer, I need a way to signal "let me finish this batch of work quietly" so that
my module's multi-step internal processing doesn't prematurely wake up every other reactive
listener in the system on every intermediate step, so that I can avoid contributing to runaway
trigger cascades.

**Why this priority**: An optimization/robustness primitive for an observed risk (cascade
storms), lowest urgency of the seven stories since today's round cap already provides a coarse
backstop.

**Independent Test**: From within a single processing round, emit the cooldown marker and
confirm the orchestrator applies that round's changes but does not continue into a further
reactive round; confirm a subsequent, independently-triggered round proceeds normally afterward.

**Acceptance Scenarios**:

1. **Given** a module emits the cooldown marker while producing other changes in the same round,
   **When** that round is processed, **Then** all changes from that round are applied normally,
   but no further reactive round follows from this invocation.
2. **Given** a cooldown marker was applied on a prior round, **When** a new, independent trigger
   arrives afterward (e.g. new input), **Then** processing proceeds normally, unaffected by the
   earlier cooldown.

---

### Edge Cases

- What happens when a lock file exists but its recorded process is no longer running (stale
  lock from an unclean shutdown)? → Covered by User Story 1, Acceptance Scenario 3.
- What happens when two start attempts race at nearly the same instant? → The mutex acquisition
  itself MUST be atomic so exactly one wins regardless of timing.
- What happens when a content entry's `type` is not one of the recognized values (e.g. a future
  or third-party extension type)? → It MUST be preserved but ignored by built-in listeners,
  never cause a crash.
- What happens when the idempotency suppression notice itself would be the trigger for another
  identical tool call? → The notice is a distinct content type from a tool invocation and MUST
  NOT itself be counted toward the repeated-call signature.
- What happens when an MCP server never requests the root list at all (does not support the
  capability)? → No error; the declared capability simply goes unused for that server.
- What happens when a skill uses only the minimal legacy fields (name/description) with none of
  the new specification's optional fields? → It MUST continue to work exactly as before
  (backward compatible), just without the additional capabilities those fields would unlock.
- What happens when a prune request targets an entry that was already removed? → MUST be a
  no-op, not an error.
- What happens when the cooldown marker appears repeatedly across many consecutive independent
  triggers? → Each independent trigger is unaffected by prior ones; the primitive never
  accumulates into a permanent freeze.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST prevent two instances of the same Profile from running
  concurrently, regardless of whether each is started in the foreground or as a background
  daemon. (Detail: tech-spec.md §3.2 Issue 1)
- **FR-002**: The system MUST atomically reject a second start attempt against an already-running
  Profile with an actionable error identifying the conflicting process, rather than silently
  proceeding or corrupting state.
- **FR-003**: The system MUST automatically detect and reclaim a lock left behind by a process
  that is no longer running, without manual operator intervention.
- **FR-004**: The system MUST represent each Block's content as an ordered collection of typed,
  individually-validated entries rather than a single unstructured string. (Detail:
  tech-spec.md §3.3)
- **FR-005**: The system MUST restrict which categories of content entries each built-in listener
  (destructive pruning, tool execution, skill activation, memory) is allowed to react to, based
  on whether the containing Block is internal or external in origin.
- **FR-006**: The system MUST transparently upgrade previously-saved Profile state that used the
  old unstructured content format, without data loss or startup failure.
- **FR-007**: The system MUST detect repeated tool invocations with identical target and
  parameters within a reasoning session and progressively reduce confidence in continuing to
  execute them. (Detail: tech-spec.md §3.2 Issue 2)
- **FR-008**: The system MUST suppress a tool invocation once its repeated-call confidence falls
  below a defined floor, and MUST surface an explanatory notice back to the reasoning flow in
  its place rather than executing again or failing silently.
- **FR-009**: The system MUST declare and negotiate the MCP Roots capability during client
  connection handshake, providing an accurate, protocol-compliant set of allowed root
  directories to any server that requests it. (Detail: tech-spec.md §3.2 Issue 3)
- **FR-010**: The system MUST notify already-connected, capability-aware servers when the
  configured root set changes, without requiring a full reconnect.
- **FR-011**: The system MUST discover and load skills authored using the open agent-skill
  specification's frontmatter format, including fields beyond the current minimal set. (Detail:
  tech-spec.md §3.2 Issue 4)
- **FR-012**: The system MUST support progressive disclosure for skills — loading only summary
  metadata by default, full instructions on activation, and auxiliary resource files only on
  explicit request.
- **FR-013**: The system MUST enforce a skill's declared tool-access restrictions while that
  skill is active.
- **FR-014**: The system MUST provide an explicit, synchronous-feeling request/response path for
  any module to ask memory to recall, search, or prune specific historical entries on demand,
  independent of memory's existing passive observation behavior. (Detail: tech-spec.md §3.2
  Issue 5)
- **FR-015**: The system MUST support a cooldown marker that, when present in a processing
  round's output, causes that round's changes to be applied but suppresses further reactive
  continuation from that same triggering invocation only. (Detail: tech-spec.md §3.4)
- **FR-016**: The system MUST NOT allow the cooldown marker to suppress or delay processing of a
  subsequent, independently-triggered invocation.

### Key Entities

- **Profile Lock**: A per-Profile exclusivity marker used to guarantee at most one running
  instance at a time; carries enough information to identify the owning process for staleness
  detection.
- **Block**: The fundamental unit of context; carries a type (internal/external/system), an
  ordered collection of typed content entries, and metadata (origin, retention behavior, etc.).
- **Content Entry (Atom)**: A single typed, structured element within a Block's content
  collection — the reasoning-trace, tool-invocation, pruning-command, cooldown-marker, and
  externally-facing categories are all instances of this concept.
- **Tool Invocation Signature**: The identity used to detect repeated tool calls — target plus
  parameters — and the associated decaying confidence value.
- **Allowed Directory Set ("Roots")**: The set of filesystem locations the operator has
  authorized for MCP tool servers to operate within, communicated via protocol-compliant
  handshake rather than a static startup argument.
- **Skill Descriptor**: The metadata and instructions describing a discoverable, activatable
  capability module, including its tool-access restrictions and any auxiliary resources.
- **Memory Request**: An explicit ask directed at the memory subsystem (recall, search, or prune)
  originating from any other module, distinct from memory's passive observation of ordinary
  activity.
- **Cooldown Marker**: A signal a module can attach to its own output requesting that the
  orchestrator not continue reactive processing beyond the current round for this invocation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempts to start a second instance against an already-running Profile are
  rejected, with zero observed instances of concurrent-write data corruption across normal
  operation.
- **SC-002**: A Profile whose previous process terminated uncleanly restarts successfully without
  manual cleanup in 100% of observed cases.
- **SC-003**: Every existing built-in reactive behavior (pruning, tool execution, skill
  activation, memory logging) continues to function correctly after the content-schema change,
  with zero regressions against current behavior for previously-saved Profile state.
- **SC-004**: A reasoning session that would previously loop indefinitely on an identical tool
  call is observably halted within 4 consecutive repeats of that same call, with the reasoning
  flow receiving a clear signal explaining why.
- **SC-005**: The "does not support MCP Roots" runtime warning no longer appears for any
  Roots-aware configured server.
- **SC-006**: A skill authored purely to the open specification's format (no Dolly-specific
  workarounds) is discovered and usable without modification.
- **SC-007**: Any module can obtain a memory recall or prune result without needing to author
  ad-hoc text-scanning conventions or reach into memory's internal storage directly.
- **SC-008**: A module using the cooldown marker to batch its own multi-step work produces
  measurably fewer intermediate reactive rounds than the same batch would without it, while still
  producing identical final state.

## Assumptions

- The existing naming collision between the current deep-reasoning-mode toggle and the new
  chain-of-thought content type is resolved by renaming the former; this is treated as a safe,
  non-breaking internal rename since it is not part of any external contract. (tech-spec.md
  §3.1 finding #4)
- The externally-facing content type currently used for rendering persona output to the console
  is retained as an additional, explicitly-recognized category alongside the three named in the
  original request, since removing it would regress existing user-facing behavior. (tech-spec.md
  §3.1 finding #5)
- The cooldown marker in this iteration is scope-limited to a simple boolean presence/absence
  signal; richer variants (duration, priority) are deferred as a future enhancement, not required
  for this feature to deliver value. (tech-spec.md OQ4)
- Upgrading memory's underlying similarity search from its current keyword-statistics approach to
  true semantic/embedding-based search is explicitly out of scope for this feature; this feature
  only adds the active-invocation access path, not a search-quality improvement. (tech-spec.md
  NG3, OQ1)
- Skill trust-gating/consent UX for third-party or user-scope skill directories is flagged as an
  open question and deferred, not designed as part of this feature. (tech-spec.md OQ2)
- Documentation updates (architecture and module docs) are produced during implementation of each
  corresponding change, following this project's established workflow, rather than speculatively
  during the specification phase. (tech-spec.md §4)
- The specific confidence-decay numeric defaults for tool-call idempotency are a starting point
  subject to tuning after real-world observation, not a final tuned value. (tech-spec.md OQ3)
- This feature does not introduce a distributed or multi-process architecture; all seven user
  stories are scoped to a single-operator, single-machine deployment. (tech-spec.md NG1)
