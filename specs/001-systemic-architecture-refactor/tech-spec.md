---
title: Systemic Architecture Refactor — Unified Context Engine
spec_id: SPEC-2026-001
version: 0.1.0
status: draft
author: huasushis (drafted by Claude Code via reverse-engineering + synthesis)
created: 2026-07-04
updated: 2026-07-04
tags: [architecture, refactor, block-schema, mcp, memory, skill, concurrency, cascade]
priority: P1
dependencies: []
---

# Systemic Architecture Refactor Spec

> Companion document to [`spec.md`](./spec.md) (this feature's standard User-Story spec).
> `spec.md` defines WHAT/WHY per `/speckit-specify`'s business-facing template; this document
> carries the full technical substance (data models, algorithms, protocol details, code-level
> citations) per the constitution's [Spec Rules](../../.specify/memory/constitution.md#spec-rules).
> Where the two disagree, this document is authoritative for implementation detail; `spec.md`
> is authoritative for scope and acceptance framing.
>
> Named `tech-spec.md` rather than the literal `SPEC.md` used in the original request: this
> project's filesystem (Windows) is case-insensitive, so `spec.md` and `SPEC.md` cannot coexist
> as distinct files in the same directory — a mechanical constraint discovered while writing
> this pair, not a scope change.

## 1. Overview

Dolly is a general-purpose extensible AI agent framework built on two stated philosophies:
"everything is a Block" (system/inner/outer, first-person perspective) and "everything is a
Module" (a single `DollyModule` interface unifying injection, monitoring, and LLM invocation).
The prototype today implements a working core loop — Block storage, a cascade-based module
dispatch loop, a priority lock manager, and five built-in modules (console, llm, memory, skill,
mcp) — but reverse-engineering the current codebase surfaces five concrete architectural
bottlenecks that the project owner has independently identified from operating it, plus
several additional distortions found during this audit (Section 3.1).

This spec synthesizes a first-hand, file:line-cited reverse-engineering audit of every existing
module and core subsystem with a refactoring design that: (1) closes a real process-mutex gap
that can corrupt Profile state, (2) bounds LLM recursive tool-calling that can currently loop
unchecked to a generic 20-round cascade cap, (3) achieves MCP Roots protocol compliance, (4)
aligns the skill module with the open agentskills.io specification, (5) promotes memory from a
passive bus listener to a dual-mode (passive + actively-invokable) module, (6) replaces the
today-unenforced flat-string Block content with a strictly-typed, validated atom schema, and
(7) introduces a cooperative cascade-cooldown primitive. Section 3.1 additionally documents
current-state findings the project owner did not explicitly ask about but which materially
affect the redesign (a doc/code mismatch on cascade round limits, an outer-block injection
vector into the destructive `forget` operation, and an implicit LLM-module privilege that
contradicts the stated peer-to-peer philosophy).

## 2. Goals & Non-Goals

### Goals

- **G1**: Eliminate concurrent-instance data corruption risk for a given Profile (Issue 1).
- **G2**: Bound LLM recursive tool-calling with a principled idempotency/confidence-decay
  mechanism, distinct from and tighter than the generic cascade round cap (Issue 2).
- **G3**: Achieve MCP specification compliance for Roots capability negotiation, eliminating
  the runtime warning and enabling servers to receive an accurate allowed-directory set
  (Issue 3).
- **G4**: Align the skill module's frontmatter parsing, discovery, and activation pipeline with
  the agentskills.io open specification (Issue 4).
- **G5**: Expose memory as dual-mode: retain passive bus-listener logging AND add an active
  invocation surface any module can call synchronously within a cascade round (Issue 5).
- **G6**: Replace `Block.content: string` with a strictly-typed, validated atom array; formalize
  per-module ingestion topology (which modules see `inner`, `outer`, or both) as an enforced
  contract rather than an implicit convention (Section 3 of the source request).
- **G7**: Introduce a cooperative `sleep` primitive that lets a module suppress reactive
  cascade continuation for its own batch of work, without introducing deadlock risk (Section 4).
- **G8**: Preserve the "inner world" first-person persona illusion in the LLM's actual voice —
  the atom schema is an internal wire format; nothing about it should make the persona's
  user-visible behavior (via `speak` atoms) more robotic or JSON-flavored.
- **G9**: Correct the doc/code and philosophy/implementation mismatches discovered during the
  audit (Section 3.1) as part of the same refactor, since they compound the five named issues.

### Non-Goals

- **NG1**: Distributed/multi-process architecture. The LevelUpper multi-agent P2P extension is
  a separate, already-in-progress effort; this spec only ensures the `signal` outer-atom type
  (Section 3.3) leaves room for it, without designing LevelUpper itself.
- **NG2**: Adding new LLM providers or replacing the DeepSeek/OpenAI-compatible `LLMClient`.
- **NG3**: True embedding-based vector search for memory. `MemoryStore.search()` today is
  TF-IDF + cosine similarity (`src/memory/nlp.ts`), not embeddings, despite the source request's
  "vector-search" terminology. This spec makes memory *actively invocable*; upgrading the
  underlying similarity engine is a separate, independent effort (see Open Questions OQ1).
- **NG4**: A consent/permission UI for MCP roots or third-party skill directories. Dolly is a
  single-operator local tool today; roots are declared statically in configuration.
- **NG5**: Rewriting `EventBus` as a new pub/sub framework. Section 3.5 generalizes the
  *existing* `tool.call_requested` convention rather than replacing the bus.

## 3. Detailed Design

### 3.1 Reverse-Engineered Baseline (Evidence)

The following is the confirmed current architecture, established via direct reads of every
core file and built-in module (not inference from documentation, which is itself shown below
to have drifted from the code in at least one place):

| Subsystem | File | Confirmed behavior |
|---|---|---|
| Block model | `src/blocks/index.ts` (38 lines) | `Block { id, type: string, content: string, meta: Record<string,unknown>, created: number }`. `content` is a **flat string** today — the root cause requiring G6. |
| Cascade loop | `src/main.ts:172-190` | Repeatedly calls `registry.pushChanges(changes)`, applies mutations, loops until no new mutations **or a 20-round hard cap** (`if (round >= 20) break`, line 187). |
| Module dispatch | `src/modules/registry.ts:137-150` | `pushChanges()` awaits each module's `onBlocksChanged` **sequentially** in a `for` loop — not concurrent. Head-of-line blocking: one slow module delays every module after it in registration order. |
| Lock manager | `src/core/lock.ts` | Priority-based async mutex. `builtin/llm` acquires with `priority=Infinity` during deep-thinking mode (`llm/index.ts:114,149`), holding the lock for the full remote API round-trip. |
| Forget mechanism | `src/main.ts:122-134` (`scanForget`) | Regex-scans **all** added block content for fenced `{"forget":"ID"}`, **with no `block.type` filter at all** — scans `outer` blocks too. |
| LLM parser | `extensions/builtin/llm/index.ts:13-36` (`parseJsonCommands`) | Two-stage: fenced-JSON primary, raw-inline-JSON fallback for `thinking`/`tool`/`forget` keys. **Zero loop/dedup/idempotency guards** anywhere in the file. `respondedTo` Set (line 7) dedups by input block ID only — prevents re-answering the same message, not repeated tool calls. `pendingQueue` (line 9) is an unbounded array. |
| MCP client | `extensions/builtin/mcp/index.ts:26` | `new Client({name:"dolly",version:"0.1.0"}, {capabilities:{}})` — capabilities object is **literally empty**. `onBlocksChanged` is a no-op (`return []`, lines 83-84) — MCP is **not** a Block-subscriber today. |
| Skill module | `extensions/builtin/skill/index.ts` | `parseFrontmatter()` (lines 80-89) is a naive regex extracting only `name`/`description`. Discovery hardcoded to `["./skills","~/.dolly/skills"]` plus a sibling `skills/` dir (line 113). Activation is a separate, hidden "guard LLM" batch call (lines 48-58), invisible to the primary model. |
| Memory module | `extensions/builtin/memory/index.ts` | Purely reactive: `onBlocksChanged` (logs everything, scans for `{"recall":"hard/soft"}` text) + `c.on("midnight.tick", ...)`. `export function getStore()` (line 137) has **zero call sites** anywhere in the repo (confirmed by exhaustive grep) — dead code, not a real active-invocation interface. |
| Memory engine | `src/memory/store.ts` | Already implements `search()`, `recall()`, `drill()`, `summarize()`, `hasEntriesForToday()` — TF-IDF cosine similarity (`src/memory/nlp.ts`), not embeddings. The active-invocation gap is purely at the module/bus boundary; the engine itself needs no rewrite. |
| Console module | `extensions/builtin/console/index.ts` | Confirmed dual `inner`+`outer` ingestion (lines 107-134) — the one module today that already matches the source request's "skill/memory must listen to both" pattern, just for a different reason (rendering `speak` atoms out + logging user history in). |
| Daemon mutex | `bin/dolly.js:22-34` vs `src/daemon/index.ts:19-35` | `serve` without `--daemon` directly `import()`s `main.ts` (bin/dolly.js line 31), **completely bypassing** `start()`'s own liveness-probe guard, which is itself a TOCTOU race (`existsSync` → `process.kill(pid,0)` → spawn, not atomic). `main.ts:259-261` unconditionally writes the pidfile with a comment admitting the gap. |
| Tool-call routing | `src/main.ts:143-146` | `bus.on("tool.call_requested", p => bus.emit("tool.execute", p))` — a hardcoded single-target forward. Only `mcp/index.ts` listens for `tool.execute`. There is no namespace concept; tool-calling is implicitly MCP-module-only today. |

**Independent findings beyond the five named issues** (Goal G9):

1. **Doc/code cascade-limit mismatch**: `docs/ARCHITECTURE.md` and `docs/MODULES.md` both state
   the cascade loop runs "最多 3 轮" (max 3 rounds). The actual code (`main.ts:187`) caps at
   **20 rounds**. This predates this refactor and should be corrected when docs are updated
   (Section 4, Development Workflow step 1) regardless of which round-limit value is chosen
   going forward.
2. **`forget` scans `outer` blocks** (`main.ts:122-134`, no type filter): an external actor —
   user chat input, or a tool result whose payload happens to contain matching text — can
   trigger deletion of arbitrary blocks today. This is a real content-injection-into-destructive-
   operation gap, independent of but related to the source request's explicit "forget subscribes
   to `inner` only" rule (Section 3.3 closes this).
3. **Tool-calling is implicitly LLM-module-privileged**: the bus chain
   `tool.call_requested → tool.execute` is consumed only by the MCP module; there is no
   namespace routing. This contradicts the source request's Uniform Module Architecture (P2P)
   philosophy — today, only blocks the LLM module chooses to parse as `{"tool":...}` can ever
   reach MCP. Section 3.5 generalizes this into a namespace-routed, multi-target convention so
   memory and skill can be reached the same way, uniformly.
4. **Naming collision**: the existing `{"thinking":"difficult"|"solved"}` deep-reasoning-mode
   toggle (consumed by `llm/index.ts:70-71,146`) uses the same JSON key as the source request's
   new `{"type":"thinking","data":"..."}` CoT-snapshot atom, with an entirely different meaning.
   Resolved in Section 3.3 by renaming the existing toggle to a `reasoning_mode` atom.
5. **`{"speak":...}` has no home** in the source request's literal 3-type inner-atom list
   (thinking/toolcall/forget) — it is console's sole externalization channel today and cannot be
   dropped without regressing existing functionality. Resolved in Section 3.3 as an explicit 4th
   inner atom type.
6. **Platform mismatch**: the source request's suggested `flock` is POSIX-only. This repository
   runs on **Windows** (working directory `E:\Huasushis\program\Dolly`) — Section 3.2 (Issue 1)
   uses a cross-platform primitive instead.

### 3.2 Issue-by-Issue Target Design

#### Issue 1 — Concurrent Process Mutex

**Target**: a single atomic instance-lock primitive shared by both entry paths.

- Replace the `existsSync` → `kill(pid,0)` → `writeFileSync` sequence with an atomic
  exclusive-create: `fs.open(pidfilePath, 'wx')` (Node's `wx` flag maps to `O_CREAT|O_EXCL`,
  atomic on both POSIX and Windows via libuv — no native addon, no new dependency).
- On `EEXIST`: read the existing PID, live-probe it via the existing `process.kill(pid, 0)`
  trick. If alive → reject the new `start`/`serve` with a clear, actionable, non-zero-exit
  error ("Profile '<name>' is already running (pid <pid>). Use `dolly stop` first."). If dead
  (stale pidfile) → unlink and retry the exclusive open once (accepting the narrow window where
  two processes both detect staleness simultaneously as a rare, non-corrupting race, since the
  loser's retry will simply hit a fresh `EEXIST` against the winner's newly-written live pid).
- **Both** `bin/dolly.js`'s foreground `serve` branch and `src/daemon/index.ts`'s `start()` MUST
  call the same shared `acquireInstanceLock(profileName)` function — closing the bypass at
  `bin/dolly.js:22-34` where foreground serve currently skips the guard entirely. This is a
  one-function consolidation, not two parallel implementations.
- Scope: the lock is per-Profile (keyed by the resolved profile name/pidfile path already used
  by `daemon/index.ts`), not global — multiple *different* Profiles running concurrently remains
  supported and unaffected.

#### Issue 2 — LLM Output Idempotency

**Target**: a per-cascade-session call-signature ledger with confidence decay, layered
underneath (not replacing) the existing generic 20-round cascade cap.

- Every `toolcall` atom (Section 3.3) carries a `call_id` and a `(tool, params)` pair. Compute a
  stable signature hash of `(tool, JSON-canonicalized params)`.
- Maintain a ledger `Map<signature, {count: number, confidence: number}>` scoped to the current
  cascade "session" (reset on `midnight.tick`, mirroring the existing reset convention already
  used by `llm/index.ts`'s `respondedTo` and `skill/index.ts`'s `seenTriggers`).
- On each occurrence of a signature: `confidence *= 0.5` (starting at `1.0`). When `confidence`
  drops below a floor (default `0.1` — i.e., after 4 consecutive identical calls: 1.0 → 0.5 →
  0.25 → 0.125 → suppressed), suppress execution and inject a synthetic `error` outer atom
  (Section 3.3) explaining the suppression, so the LLM sees *why* the call vanished and can
  course-correct, rather than the tool silently never returning.
- This is deliberately **tool-call-specific and confidence-graded**, unlike `main.ts`'s existing
  `round >= 20` cascade cap, which is generic, all-or-nothing, and currently only logs via
  `dlog` (invisible to the end user experiencing a stuck conversation). The two mechanisms
  compose: idempotency suppression is the fast, targeted circuit-breaker; the 20-round cap
  remains the ultimate backstop for cascades that loop without any single repeated call
  signature (e.g. alternating between two different calls).
- Defaults (`0.5` decay factor, `0.1` floor, 4-call trigger) are a starting point — see OQ3.

#### Issue 3 — MCP Roots Capability

**Target**: full Roots negotiation, matching the official spec
(`https://modelcontextprotocol.io/specification/2025-06-18/client/roots`, confirmed via direct
fetch: capability shape `{"roots":{"listChanged":true}}`; server sends a `roots/list` request;
client responds `{"roots":[{"uri":"file://...","name":"..."}]}`, `uri` MUST be `file://`; client
MUST send `notifications/roots/list_changed` on changes if `listChanged:true` was declared).

- `mcp.json` gains a top-level `roots` array: `{"roots":[{"path":".","name":"Dolly Project"}],
  "servers": {...}}`.
- `extensions/builtin/mcp/index.ts:26` changes from `{capabilities: {}}` to
  `{capabilities: {roots: {listChanged: true}}}` — one shared declaration reused for all
  configured servers.
- Register `client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots:
  configuredRoots.map(r => ({ uri: pathToFileURL(resolve(r.path)).href, name: r.name })) }))`
  **before** `client.connect()` for each server (SDK types confirmed present:
  `ListRootsRequestSchema`/`RootSchema` exported from
  `node_modules/@modelcontextprotocol/sdk/dist/*/types.d.ts` at lines 5523/5531).
- On `dolly mcp reload` (config change detected), call `client.sendRootsListChanged()` for every
  live connection that declared `listChanged: true` (SDK enforces this at
  `client/index.js:394-399` — throws if the capability wasn't declared, so declaration must
  precede any such call).
- Once verified working end-to-end, the `fs` server's hardcoded `"."` positional CLI arg in
  `mcp.json` (the literal fallback the runtime warning references) can be removed, since the
  server will instead receive roots via the protocol handshake rather than argv.

#### Issue 4 — Agent-Skill Spec Alignment

**Target**: bring frontmatter parsing, discovery, and activation in line with agentskills.io
without discarding the existing low-cost guard-LLM trigger.

- **Frontmatter**: replace the naive `name`/`description`-only regex (`skill/index.ts:80-89`)
  with a real YAML frontmatter parse capturing all agentskills.io fields (`license`,
  `compatibility`, `metadata`, `allowed-tools`, etc.); unknown/future fields are preserved on the
  parsed object rather than silently dropped, so authoring a spec-compliant `SKILL.md` today
  doesn't lose data even before every field has a consumer.
- **Discovery**: add `.claude/skills/` and `.agents/skills/` to the default search path,
  alongside the existing configurable `skills_dirs` (default `["./skills","~/.dolly/skills"]`),
  each tagged with a scope (`project` vs `user`) for future trust-gating (Open Question OQ2).
- **Progressive disclosure**: support a skill authored as a directory (`SKILL.md` + `scripts/` +
  `references/` + `assets/`). Only `name`+`description` (tier 1) load into the system prompt by
  default; the full `SKILL.md` body (tier 2) loads when the skill triggers; `references`/`assets`
  (tier 3) load only on explicit request via a `toolcall` atom targeting `skill.read_resource`,
  not eagerly — directly addressing the source request's "codebase shorter than its description"
  symptom by making the eagerly-loaded surface proportionally smaller.
- **Activation — dual mode**: keep the existing guard-LLM batch trigger (low-cost default,
  unchanged mechanism) **and** additionally surface every skill's `name`+`description` directly
  in the primary model's system prompt, so it can request a skill explicitly via
  `{"type":"toolcall","data":{"tool":"skill.invoke","params":{"name":"..."}}}` — reusing the
  same namespaced-toolcall convention as Issues 2 and 5 (Section 3.5), rather than inventing a
  third distinct activation mechanism.
- **`allowed-tools`**, once parsed, restricts which MCP tools are usable while that skill's
  content is active in context — a new least-privilege capability with no equivalent today.

#### Issue 5 — Dual-Mode Memory

**Target**: memory becomes reachable via the same namespaced-toolcall mechanism used for MCP
tools and skill invocation — no bespoke RPC layer required (see Section 3.5 for why a new
synchronous primitive is unnecessary).

- Memory registers as the handler for `toolcall` atoms whose `tool` field starts with
  `memory.` — concretely `memory.recall`, `memory.prune`, `memory.search`, mapping directly onto
  the already-implemented `MemoryStore.recall()` / `store.ts` deletion path (net new, since
  today nothing prunes programmatically) / `MemoryStore.search()`.
- Any module — including the primary LLM, via a normal `toolcall` atom, exactly like an MCP
  tool call — can invoke these without needing to author fenced-JSON-in-flat-string conventions
  (today's `{"recall":"hard|soft"}` text-scan) or reach across module boundaries via a raw
  import.
- `export function getStore()` (`memory/index.ts:137`) is removed once the toolcall-based
  interface lands — it has zero call sites today (confirmed by grep) and, even if it had callers,
  a raw cross-module import bypasses the `ctx`/`emit` conventions that keep module internals from
  leaking across boundaries (constitution Principle III, Reusability: "internal implementation
  details MUST NOT leak across module boundaries").
- Passive logging (today's `onBlocksChanged` behavior) is retained unchanged — this is additive,
  not a replacement.

### 3.3 Unified Block/Atom Schema

**Design decision on the top-level shape**: the source request's draft JSON duplicates `type`
and `source` inside the proposed object, but these already exist at the correct level today
(`Block.type`, `Block.meta.source`). Re-nesting them would create two sources of truth for the
same fact. Instead, this spec **promotes `Block.content` from `string` to a typed atom array**
and adds two new optional top-level `Block` fields (`description`, `extra_body`) — preserving
`type`/`source`/`meta` exactly where they already correctly live. This is offered as a
deliberate, reasoned deviation from the literal draft, per the source request's own invitation
to "optimize the key names with valid engineering reasoning."

```typescript
interface Block {
  id: string;
  type: "system" | "inner" | "outer";
  description?: string;          // NEW — optional human-readable summary (debugging/telemetry)
  content: ContentAtom[];        // CHANGED — was string; now a typed, validated atom array
  extra_body?: unknown;          // NEW — forward-compat passthrough for 3rd-party extensions
  meta: Record<string, unknown>; // UNCHANGED — pinned, source, decay_rate + extension keys
  created: number;
}
```

`system` blocks use the same `content: ContentAtom[]` shape for type uniformity, wrapping the
prompt text as a single `{type:"message", data: "..."}` atom rather than special-casing a
separate content type for the system role.

**Inner atom types** (internal reasoning flow):

| Type | Shape | Purpose | Note |
|---|---|---|---|
| `thinking` | `{"type":"thinking","data":"..."}` | Chain-of-Thought snapshot | As specified in the source request |
| `toolcall` | `{"type":"toolcall","data":{"tool":"...","params":{...}},"call_id":"..."}` | Tool/module invocation request | `call_id` added (not in the literal draft) — required to correlate an eventual `tool_result` outer atom back to this call; also the key for Issue 2's idempotency ledger |
| `forget` | `{"type":"forget","target_idx":"..."}` | Memory/context pruning command | As specified; scanning restricted to `inner` blocks only (closes the Section 3.1 finding #2 injection gap) |
| `sleep` | `{"type":"sleep","value":true}` | Cascade cooldown marker | Section 3.4 |
| `speak` | `{"type":"speak","data":"..."}` | Persona-voiced output to the user-facing console | **New 4th type**, not in the source request's literal 3-type list — required because it is console's sole externalization channel today (`console/index.ts:137-157`); omitting it would regress existing functionality (Section 3.1 finding #5) |
| `reasoning_mode` | `{"type":"reasoning_mode","data":"difficult"\|"solved"}` | Deep-thinking-mode toggle | **Renamed** from the pre-existing `{"thinking":"difficult"/"solved"}` convention to resolve the key collision with the new CoT `thinking` atom (Section 3.1 finding #4) |

*Subscription rule*: the framework's `forget` scan and the `mcp` module's tool-call listener
subscribe to `inner` blocks **only** — matching the source request exactly, and closing the
outer-block injection gap identified in Section 3.1.

**Outer atom types** (external environment interaction) — designed per the source request's
explicit invitation ("formulate an elegant schema... based on your expertise"):

| Type | Shape | Purpose |
|---|---|---|
| `message` | `{"type":"message","data":"..."}` | Free-text input (chat message, webhook body rendered as text) |
| `tool_result` | `{"type":"tool_result","call_id":"...","data":...}` | Result of a prior `toolcall` atom; `call_id` correlates back to the originating request — this is what makes Issue 2's idempotency ledger and Section 3.5's namespaced routing addressable |
| `signal` | `{"type":"signal","name":"...","data":...}` | Generic structured non-conversational event envelope (webhooks, timers, presence pings) — deliberately generic to leave room for the LevelUpper multi-agent extension's inter-agent messages without this spec needing to design that extension (NG1) |
| `error` | `{"type":"error","data":"...","origin":"..."}` | Distinguishes environment/tool failure from success — enables Issue 2's confidence-decay suppression to specifically surface repeated-failure loops, the more dangerous case, distinctly from repeated-success loops |

*Subscription rule*: `skill` and `memory` subscribe to **both** `inner` and `outer` — matching
the source request exactly.

**Ingestion topology — current vs. target** (the explicit deliverable requested: "map out...
which modules listen to inner, outer, or both"):

| Module | Listens today | Listens (target) | Notes |
|---|---|---|---|
| `builtin/console` | inner + outer (unfiltered) | inner + outer (unchanged) | Renders `speak` atoms out; logs `message` outer atoms as history |
| `builtin/llm` | inner + outer (unfiltered) | inner + outer (unchanged, now atom-aware, not regex-over-flat-string) | Primary reasoning consumer; must see everything |
| `builtin/memory` | inner + outer (de facto) | inner + outer, **plus** active `toolcall` responder for `memory.*` | Dual-mode per Issue 5 |
| `builtin/skill` | inner + outer (de facto) | inner + outer, **plus** active `toolcall` responder for `skill.invoke`/`skill.read_resource` | Matches source request |
| `builtin/mcp` | **neither** (no-op `onBlocksChanged`; reached only via a hardcoded bus forward seeded by the LLM module's own text parsing) | `inner` only — direct `toolcall`-atom listener, decoupled from the LLM module | Closes Section 3.1 finding #3 (implicit LLM privilege); matches source request |
| framework `forget` scan (`main.ts`) | inner + outer (unfiltered) | `inner` only | Closes Section 3.1 finding #2 |

**Payload validation rules** (the explicit deliverable requested: "schema validation rules for
each atomic content type"):

- Every atom MUST have a `type` field matching one of the enumerated string literals above; an
  atom with an unrecognized `type` is preserved verbatim (forward-compat) but ignored by all
  built-in parsers rather than throwing, so a future/third-party atom type doesn't crash the
  cascade.
- `toolcall.data.tool` MUST be a non-empty string matching `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`
  (namespace-dot convention, e.g. `memory.recall`, `mcp.fs.read_file`, or a bare tool name for
  backward compatibility with existing single-namespace MCP tools).
- `toolcall.call_id` and `tool_result.call_id` MUST be present and MUST correlate exactly one
  `tool_result` (or `error`) per `toolcall` — a `toolcall` receiving zero results after the
  idempotency floor is reached is captured by Issue 2's suppression path, not left dangling.
- `forget.target_idx` MUST reference an existing Block `id` at scan time; a reference to a
  nonexistent id is a silent no-op (already the current behavior of `context.removeBlock()`),
  not an error — deletions racing with cascade rounds are expected, not exceptional.
- `sleep.value` MUST be exactly boolean `true` in this iteration (see Open Question OQ4 on
  whether a duration/priority value is warranted later); any other value is ignored.
- Malformed JSON at the parse stage (today's `parseJsonCommands` two-stage fenced/raw-fallback
  parser) continues to degrade gracefully to "no atoms recognized this round," matching current
  behavior — this spec does not change parse-failure handling, only what a successfully-parsed
  atom must look like.

**Few-shot system-prompt enforcement** (explicitly requested: "heavily enforced within the
LLM's System Prompt using clear, few-shot examples... demonstrating a single JSON block
containing multiple staggered `thinking` blocks and clustered `toolcall` instructions"):

```json
{
  "content": [
    { "type": "thinking", "data": "用户想知道 dolly.json 里的 skill 目录配置。先读文件确认。" },
    { "type": "toolcall", "call_id": "c1", "data": { "tool": "mcp.fs.read_file", "params": { "path": "dolly.json" } } },
    { "type": "thinking", "data": "读到配置后，再检查对应目录是否存在，两步都做完再回复用户。" },
    { "type": "toolcall", "call_id": "c2", "data": { "tool": "mcp.fs.list_dir", "params": { "path": "./skills" } } },
    { "type": "speak", "data": "我看一下配置和目录，马上告诉你。" }
  ]
}
```

```json
{
  "content": [
    { "type": "thinking", "data": "两个工具都返回了。目录存在，配置也对得上，可以直接回答，不需要再多问。" },
    { "type": "speak", "data": "skill 目录配置是 ./skills，目录也确实存在，里面已经有内容了。" }
  ]
}
```

This mirrors the existing per-module-owns-its-prompt convention already established this
session ([[feedback_module_prompts]] — each module injects only its own domain's prompt
guidance); the `llm` module's `systemPrompt()` owns this few-shot block since `thinking`/
`toolcall`/`speak` are all consumed or produced within its own domain, not hardcoded into
`main.ts`'s framework-level prompt as `{"speak":...}`/`{"forget":...}` currently are
(itself one of the Section 3.1 findings worth correcting during implementation).

**Backward compatibility**: existing `.dolly/profiles/*/context.json` files persist
`Block.content` as a flat string. On load, a runtime shim wraps any string-typed `content`
field as `[{type:"legacy_text", data: <original string>}]` — a synthetic atom type recognized
only by the load path, never produced going forward — so upgrading does not crash on old
Profile state (Technical Constraints, Section 4).

### 3.4 Sleep / Cooldown Primitive

- A `sleep` inner atom (`{"type":"sleep","value":true}`), when present in ANY block inserted
  during a `cascade()` round's `pushChanges()` call, causes the orchestrator to **apply that
  round's mutations as normal** (every other module's inserts/deletes/updates still land —
  consistent with the existing cumulative-update principle: one round processes everyone) but
  then **break the loop immediately** instead of proceeding to round+1, even if further mutations
  would otherwise have been produced.
- Scope is strictly **this cascade invocation** — a fresh `cascade()` call triggered by the next
  external input (new user message, new tool result, next `midnight.tick`) proceeds completely
  normally, unaffected by a previous round's sleep. This bounds the primitive to "stop looping
  this burst," never "pause the daemon," which rules out permanent-freeze/deadlock risk by
  construction — no lock is held, no timer is set, nothing needs to "wake" the system back up
  because nothing was blocked in the first place.
- Interaction with the existing 20-round cap (`main.ts:187`): `sleep` is strictly tighter (can
  fire on round 1) and voluntary/cooperative; the round cap remains the involuntary backstop for
  cascades where no module asks to sleep but looping continues regardless (e.g. Issue 2's
  scenario, which is why Issue 2 needs its own dedicated mechanism rather than relying on
  `sleep` — a hallucinating LLM will not cooperatively emit `sleep`).

### 3.5 Generalizing the Toolcall Router (cross-cutting infrastructure)

Issues 2, 4, and 5 all need *some* module other than `llm` to receive a `toolcall` atom and act
on it. The natural-seeming option — adding a new synchronous request/response primitive to
`EventBus` — is **rejected** in favor of generalizing the mechanism that already exists for MCP:

- Today, `main.ts:143-146` hardcodes `bus.on("tool.call_requested", p =>
  bus.emit("tool.execute", p))`, and only `mcp/index.ts` listens for `tool.execute`. This is
  already a fire-a-request/receive-a-result-as-a-new-block round trip (`tool.execute` →
  MCP executes → emits a result → a new `outer` `tool_result` atom is added → the next
  `cascade()` round picks it up) — it just isn't namespaced or multi-target.
- **Target**: `DollyModule` gains one new optional lifecycle hook,
  `onToolCall?(ctx, call: {tool: string, params: unknown, call_id: string}): Promise<unknown>`.
  Any module implementing it registers the namespace prefix(es) it owns (e.g. `mcp` owns
  `mcp.*` and bare legacy tool names for compatibility; `memory` owns `memory.*`; `skill` owns
  `skill.*`). The router (in `registry.ts`, alongside `pushChanges`) dispatches each `toolcall`
  atom's `tool` field to the matching module's `onToolCall`, injects the returned value as a
  `tool_result` outer atom carrying the same `call_id`, and falls back to today's
  generic `tool.execute` bus emission for unnamespaced/legacy tool names.
- This reuses the cascade+bus idiom that already exists rather than adding a second, parallel
  synchronous RPC layer — directly serving the constitution's Reusability principle ("Code MUST
  be written to be composable... Shared logic MUST be extracted... rather than duplicated") and
  keeping the fix additive to `registry.ts`/`base.ts` rather than a new subsystem.

## 4. Technical Constraints

- **Platform**: MUST work on both Windows (this repository's actual runtime environment —
  working directory `E:\Huasushis\program\Dolly`) and POSIX. No `flock`-based solution (POSIX-
  only). The `fs.open(path, 'wx')` primitive (Issue 1) and the namespaced toolcall router
  (Section 3.5) are both pure Node.js, requiring no native addons — consistent with the
  project's current zero-native-dependency footprint (`package.json` confirmed: no lock/mutex
  library present today).
- **No new heavyweight dependencies** without justification (constitution Reusability/
  Scalability spirit). A YAML parser for Issue 4's frontmatter is the one plausible new
  dependency; evaluate against hand-rolling a minimal YAML-subset parser only if frontmatter
  stays simple in practice.
- **Backward compatibility**: existing `.dolly/profiles/*/context.json` files (flat-string
  `Block.content`) MUST NOT crash the daemon on upgrade — the `legacy_text` load-time shim
  (Section 3.3) is mandatory, not optional.
- **MUST NOT break `pnpm typecheck`** (constitution Principle I, NON-NEGOTIABLE).
- **MUST preserve the first-person "inner world" persona voice** — all schema changes are wire-
  format only; `speak` atom content is the only thing end users perceive, and its tone is
  governed by `dolly.json`'s `agent.persona`, unaffected by this refactor.
- **Documentation timing**: per this project's own established workflow (CLAUDE.md
  "开发流程": docs → code → typecheck → test → commit; and this session's own prior
  correction — [[feedback_daemon_architecture]]-adjacent lesson about doc/code drift), `docs/
  ARCHITECTURE.md` and `docs/MODULES.md` updates are sequenced as part of implementation
  (alongside the corresponding code change), not produced speculatively during this spec-writing
  phase describing a not-yet-built system. This spec (plus the audit in Section 3.1) is the
  interim record of target architecture until those docs are updated in lockstep with the actual
  code changes, per the mandated workflow.

## 5. Error Handling

| Scenario | Handling |
|---|---|
| Two `start`/`serve` invocations race for the same Profile | Second caller's `fs.open(..., 'wx')` receives `EEXIST`; live-probe the recorded PID; if alive, reject with a clear non-zero-exit message naming the Profile and PID; if dead, reclaim (unlink + retry open once) |
| Legacy (flat-string) Block loaded from an old `context.json` | Runtime shim wraps it as `[{type:"legacy_text", data: <string>}]` at load time; no atom-array validation applied to legacy content |
| MCP server does not support Roots (older server) | Capability negotiation is per-connection; if the server never sends a `roots/list` request, the client's declared capability is simply unused for that server — no error, no behavior change from today for non-participating servers |
| Malformed/unparseable atom JSON from the LLM | Falls back to "no atoms recognized this round" (unchanged from today's `parseJsonCommands` failure mode) — logged, not thrown |
| `toolcall` with an unrecognized namespace (no module claims the prefix, and it doesn't match a legacy bare tool name) | Router injects an `error` outer atom (`origin: "router"`) explaining no handler was found, correlated via `call_id`, so the LLM sees the failure instead of the call silently vanishing |
| Idempotency floor reached (Issue 2) | Suppress execution; inject an `error` outer atom explaining suppression + the repeated signature, correlated via `call_id` |
| `memory.*`/`skill.*` toolcall handler throws | Caught at the router level, converted to an `error` outer atom (`origin: "<module>"`) rather than crashing the cascade round for other modules' mutations already collected that round |
| `sleep` atom present alongside a genuinely still-pending, unresolved `toolcall` (e.g. a module sleeps mid-multi-step-batch before its own tool result has returned) | Sleep only suppresses the *cascade loop continuing*, not pending async work already in flight (e.g. an outstanding MCP call) — the eventual `tool_result` block still lands via its own bus event and starts a **new** `cascade()` invocation when it arrives, per Section 3.4's "next external input proceeds normally" rule |

## 6. Acceptance Criteria

- **AC1 (Issue 1)**: Given a Profile is already running as a daemon, When a second `dolly start`
  or foreground `dolly serve` is invoked for the same Profile, Then the second invocation exits
  non-zero with a message naming the running PID, and the first instance's state is unaffected.
- **AC2 (Issue 1)**: Given a Profile's daemon process has died without cleaning up its pidfile,
  When `dolly start` is invoked for that Profile, Then the stale pidfile is reclaimed and the new
  instance starts successfully.
- **AC3 (Issue 2)**: Given the LLM emits four consecutive `toolcall` atoms with an identical
  `(tool, params)` signature, When the fourth is processed, Then it is suppressed and an `error`
  outer atom explaining the suppression is injected instead of executing a fifth time.
- **AC4 (Issue 3)**: Given `mcp.json` declares a `roots` array, When the MCP client connects to a
  configured server, Then the server's `roots/list` request (if sent) receives a non-empty,
  accurate `file://`-URI result, and no "Client does not support MCP Roots" warning is logged.
- **AC5 (Issue 4)**: Given a third-party `SKILL.md` authored with agentskills.io frontmatter
  (`license`, `compatibility`, `allowed-tools`), When it is discovered from `.claude/skills/`,
  Then it loads without modification and its `allowed-tools` restricts available MCP tools while
  active.
- **AC6 (Issue 5)**: Given any module emits a `{"type":"toolcall","data":{"tool":"memory.recall",
  ...}}` atom, When the cascade processes it, Then a correlated `tool_result` outer atom
  containing the recalled content is injected within the same or immediately following cascade
  round — without that module needing to author fenced-JSON-in-flat-string text or import
  `src/memory/store.ts` directly.
- **AC7 (Section 3)**: Given a Block is loaded from a legacy `context.json` with string
  `content`, When the daemon starts, Then it is transparently wrapped as a `legacy_text` atom and
  the daemon does not crash.
- **AC8 (Section 4)**: Given a module inserts a block containing a `sleep` atom during a cascade
  round, When that round's mutations are applied, Then no further cascade round is triggered by
  this invocation, but a subsequent, independently-triggered `cascade()` call proceeds normally.

## 7. Context References

**Core**: `src/blocks/index.ts`, `src/main.ts` (cascade `main.ts:172-190`, forget scan
`main.ts:122-134`, tool-call bus forward `main.ts:143-146`, pidfile write `main.ts:259-261`),
`src/core/context.ts`, `src/core/lock.ts`, `src/core/bus.ts` (referenced, not directly quoted
above), `src/modules/base.ts`, `src/modules/registry.ts` (`pushChanges` `registry.ts:137-150`).

**Daemon/CLI**: `bin/dolly.js` (`serve` branch `bin/dolly.js:22-34`), `src/daemon/index.ts`
(`start()` `daemon/index.ts:19-35`), `src/daemon/attach.ts` (referenced for the existing TCP
relay/port architecture the mutex design dovetails with).

**Built-in modules**: `extensions/builtin/llm/index.ts` (`parseJsonCommands`
`llm/index.ts:13-36`, deep-thinking lock `llm/index.ts:114,149`), `extensions/builtin/mcp/
index.ts` (`mcp/index.ts:26`, no-op `onBlocksChanged` `mcp/index.ts:83-84`), `extensions/
builtin/memory/index.ts` (`onBlocksChanged` `memory/index.ts:68-125`, `getStore`
`memory/index.ts:137`), `extensions/builtin/skill/index.ts` (`parseFrontmatter`
`skill/index.ts:80-89`, discovery `skill/index.ts:113-120`, guard-LLM trigger
`skill/index.ts:48-58`), `extensions/builtin/console/index.ts` (`onBlocksChanged`
`console/index.ts:107-134`, `parseSpeak` `console/index.ts:137-157`).

**Memory engine**: `src/memory/store.ts`, `src/memory/nlp.ts`.

**Config**: `dolly.json`, `mcp.json`.

**Docs (to be updated during implementation, not this spec phase)**: `docs/ARCHITECTURE.md`,
`docs/MODULES.md`, `docs/CONFIG.md`.

**External specs**: MCP Roots — `https://modelcontextprotocol.io/specification/2025-06-18/
client/roots` (fetched and confirmed directly this session). Agent Skills —
`https://agentskills.io` specification and `client-implementation/adding-skills-support`
(findings incorporated from investigation earlier in this session; not re-fetched this turn).
Spec Rules format — `https://niziming.github.io/2026/03/24/Spec模式开发/#41-spec-文件的标准结构`
(this document's own format source, per `.specify/memory/constitution.md`).

**MCP SDK internals** (grepped): `node_modules/@modelcontextprotocol/sdk/dist/{cjs,esm}/client/
index.js` (capability storage line 107, `assertCapabilityForMethod` gating lines 394-399 and
427-432), `types.d.ts` (`ListRootsRequestSchema`/`RootSchema`, lines 5523/5531).

**Related in-repo memory notes**: [[feedback_module_prompts]] (each module injects only its own
domain's system-prompt guidance — directly informs Section 3.3's few-shot placement decision),
[[feedback_daemon_architecture]] (daemon-is-server/console-is-client — relevant background for
Issue 1's mutex design not regressing the existing daemon/relay separation).

**Related spec**: [`spec.md`](./spec.md) (this feature's standard User-Story companion).

## 8. Open Questions

- **OQ1**: Should `MemoryStore`'s TF-IDF similarity engine be upgraded to true embedding-based
  vector search? Out of scope for this spec (NG3); recommend a follow-up spec once the active-
  invocation surface (Issue 5) is in place and real usage patterns are observable.
- **OQ2**: What trust-gating/consent UX should govern loading skills from third-party or
  user-scope directories (`~/.dolly/skills`, `.agents/skills/`) versus project-scope
  (`./skills`, `.claude/skills/`)? Flagged but not designed here — needs a product decision, not
  just an engineering one.
- **OQ3**: The Issue 2 confidence-decay defaults (`0.5` decay factor, `0.1` floor, effectively a
  4-call trigger) are a reasoned starting point, not empirically validated. Expect tuning once
  real hallucination-loop cases are observed post-implementation.
- **OQ4**: Should the `sleep` atom eventually carry a duration or priority value instead of
  boolean-only presence (e.g. `{"type":"sleep","value":true,"rounds":3}`)? This spec deliberately
  scopes `sleep` to boolean-only for this iteration (Section 3.3's validation rule) to keep the
  cooldown semantics simple and easy to reason about; revisit if a real scenario needs
  multi-round suppression.
- **OQ5 (Section 5 brainstorming, informational — not blocking)**: Beyond the five named issues,
  this audit surfaced several performance/robustness risks worth tracking as future work rather
  than folding into this spec's scope: (a) `registry.pushChanges()`'s sequential-await dispatch
  (`registry.ts:137-150`) is head-of-line-blocking — a slow module delays every module registered
  after it; an actor-model mailbox or concurrent-dispatch-with-ordered-merge could remove this
  without sacrificing the cumulative-update principle. (b) `lock.acquire(..., Infinity)` during
  LLM deep-thinking mode (`llm/index.ts:114,149`) is a starvation risk for any other module
  needing the lock during a slow remote API call — worth bounding with a timeout-and-retry rather
  than an unbounded priority. (c) Profile persistence (`saveProfile()`) does a full synchronous
  `writeFileSync` of the entire block list every cascade round — O(n) I/O growth with context
  size and no incremental/append persistence; worth revisiting once the atom schema (Section 3.3)
  is in place, since typed atoms make incremental diffing more tractable than today's flat
  strings. (d) The synchronous `EventBus` has no backpressure — an unbounded `pendingQueue`
  (`llm/index.ts:9`) compounds this. (e) For the LevelUpper multi-agent extension specifically,
  a CRDT-based shared context (rather than the current single-writer-per-cascade-round model)
  may be worth exploring given that extension's inherently multi-writer P2P nature — flagged as
  a complementary architecture per the source request's Section 5 invitation to propose
  alternatives, not a recommendation to adopt now.

## 9. Changelog

| Date | Version | Description | Author |
|---|---|---|---|
| 2026-07-04 | 0.1.0 | Initial draft synthesizing reverse-engineering audit (Issues 1-5, schema, sleep primitive, Section 5 brainstorming) with the companion `spec.md` | huasushis (drafted by Claude Code) |
