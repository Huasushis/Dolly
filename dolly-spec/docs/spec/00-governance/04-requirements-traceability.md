# Requirements traceability

`REQ-TRACE-001` — Before `spec-candidate`, every independently falsifiable
normative requirement or invariant MUST have its own stable identifier, a
source or engineering-rationale classification, and a named verification
target, and MUST be covered by an implemented executable test or an explicitly
approved manual verification procedure; a family/umbrella identifier or merely
planned target is not candidate coverage.

This matrix is an index, not a replacement for the normative requirement.
`Owner-1` is `01-dolly_new.txt`; `Owner-2` is `02-newnew.txt`; `Owner-4` is the
2026-08-12 Memory-injection clarification; `Owner-5` is the same day's later
Extension/future-track clarification; `Owner-6` is the subsequent development
order, parallelism, and early-use clarification; `Pro` is the
non-normative engineering baseline from the conversation whose assistant text
self-identifies as GPT-5.6 Pro.

| Requirement family | Source intent | Normative contract | Primary oracle |
| --- | --- | --- | --- |
| `REQ-NORM-*`, `REQ-GOV-*`, `REQ-CONF-*`, `REQ-TRACE-*` | owner priority plus specification governance | Governance | repository validator and conformance review |
| `REQ-SCOPE-*` | Owner-1 product intent plus Owner-5 optional/future boundary | Product scope | conformance-claim and release-manifest review |
| `REQ-ID-*` | Owner-1 Block identity/JSON plus Owner-5 non-colliding Module state | Core 01 | schema, canonicalization, tombstone, and storage-scope vectors |
| `REQ-BLOCK-*` | Owner-1 Block/forward/multimodal | Core 02 | Block schemas and invalid-reference vectors |
| `REQ-PAGE-*`, `INV-PAGELOG-*` | Owner-1 broadcast Page | Core 03 | delivery model tests |
| `REQ-ACT-*`, `INV-ACTIVATION-*` | Owner-1 serial Module activation plus engineering security/restart authority closure | Core 04 and Operations 04 | reference machine, crash, binding-origin, startup-order, and downstream-abstention vectors |
| `INV-ROUTING-*` | Owner-1 allows cyclic topology | Core 05 | cycle budgets and self-delivery vectors |
| `REQ-XRPC-*`, `REQ-XLIFE-*`, `REQ-XCAP-*`, `REQ-XUPG-*`, `INV-XCAP-*` | Owner-1 decoupled Extensions/JSON plus Owner-5 multi-open/restart isolation | Extension protocol | hostile mock Extension, generation fence, state-scope, and migration suites |
| `REQ-ASSET-*` | Owner-1 asset IDs/crops/OSS | Assets service | content, crop, SSRF, and GC suites |
| `REQ-CFG-*`, `REQ-CTXN-*` | Owner-1 live config/self-change | Control plane | revision and partial-failure vectors |
| `REQ-PROC-*`, `REQ-ADMIN-*` | Owner-1 foreground/background/multi-instance | Control plane | process and lock suite |
| `REQ-CHANNEL-*` | Owner-1 external input/output and multimodal transport | Channel Extension | transport-ledger and session-isolation suite |
| `REQ-MODEL-*` | Owner-1 shared model access | Model Gateway | provider-profile conformance |
| `REQ-TOOL-*` | Owner-1 MCP/tool execution inside LLM workflows | Tool Broker | hostile server, side-effect, and unknown-outcome suite |
| `REQ-LLM-*` | Owner-1 LLM/tool/context robustness | LLM Extension | recorded adapter/tool traces |
| `REQ-MEM-*` | Owner-1/2 reliable memory and task resumption | Memory baseline | LongMemEval/LoCoMo plus Dolly sets |
| `REQ-INJECT-*` | Owner-4 no fixed repeat ban plus engineering trust boundary | Memory context-selection research | repeated-task, exact-duplicate, authority, and equal-budget vectors |
| `REQ-ASSOC-*` | latest owner clarification | Memory research | temporal-shuffle and frequency baselines |
| `REQ-XFER-*` | Owner-1 abstract thought pattern plus Pro research decomposition | Abstraction/trajectory transfer research | held-out cross-domain and negative-transfer vectors |
| `REQ-REFLECT-*` | Owner-1 long-term thinking plus Pro ReflectionPolicy correction | Reflection Policy research | evidence, shadow-replay, expiry, and regression vectors |
| `REQ-SKILL-*` | Owner-1 Agent Skills/premise | Skills Extension | catalog and hot-update suite |
| `REQ-ALARM-*` | Owner-2 complete alarm behavior | Alarm Extension | virtual-clock and DST suite |
| `REQ-FILTER-*` | Owner-5 generic 0..1000 smoothing/selection Filter | optional Filter profile | fixed-point, hold, source-trust, safe-copy, nesting, and ledger-crash vectors |
| `REQ-NAPCAT-*` | Owner-5 full but prompt-bounded interactive QQ wrapper | optional NapCatQQ Channel profile | official-registry probe, mailbox/state-machine, policy, media, isolation, and unknown-effect suites |
| `REQ-OBS-*` | Owner-1 detailed logs | Observability | redaction/replay/cardinality tests |
| `REQ-SEC-*` | Pro engineering correction | Threat model | adversarial security suite |
| `REQ-PLAT-*` | Owner-1 Linux/Windows | Cross-platform | native OS CI and failure tests |
| `REQ-TECH-*` | Pro stack proposal plus evidence-backed durability hardening | Technology profile | toolchain attestation and SQLite build-gate vectors |
| `REQ-RES-*`, `REQ-SCHED-*`, `REQ-TENSITY-*`, `REQ-TOPO-*`, `REQ-PROMO-*` | Owner-1/2 scientific validation | Research | schema-valid plan/run records, preregistration, and promotion packet |
| `REQ-BROWSER-*` | Owner-2 Camoufox/MCP test request plus Pro benchmark staging | Browser tool research | local state/artifact corpus before BrowserGym/WebArena |
| `REQ-LEARN-*` | Owner-1/2 learning intent plus Pro leakage correction | Learning research | retention, held-out, cross-domain, negative-transfer, and update vectors |
| `REQ-TESTAMENT-*` | Owner-1/2 future learning intent plus Owner-5 explicit planning request | Testament research substrate | clone/portable remap, fresh identity, isolation, leakage, crash-resume, and promotion vectors |
| `REQ-LEVELUPPER-*` | Owner-1/2 future network intent plus Owner-5 explicit planning request | LevelUpper research bridge | ACK-loss, local identity, Asset, hostile-peer, backup, lifecycle, and loop vectors |
| `REQ-COMPARE-*` | Owner-1 peer-framework goal plus Pro fairness correction | Framework comparison research | fixed-artifact equal-budget comparison packet |
| `REQ-PLAN-*` | Owner-1/5/6 request for an implementable phased plan, explicit parallel dependencies, and usable checkpoints | Roadmap | critical-path DAG, dependency/exit-gate, and early-use review |

## Current draft coverage debt

This family matrix is navigation for the current draft. It is not evidence that
each normative sentence already has an independent ID or implemented oracle.
Several chapters still use one umbrella ID to group many separately falsifiable
`MUST`/`MUST NOT` clauses. Those umbrella IDs are useful during drafting but do
not satisfy the `spec-candidate` gate in `REQ-TRACE-001`.

The repository validator currently checks document/link/JSON structure, known
ID syntax, and whether a test vector references an ID found in normative text.
It does **not** prove one defining occurrence per ID, source-claim-to-ID mapping,
one ID per independently failing clause, executable coverage of every ID, or a
passing source→requirement→test chain. No release or review packet may describe
the current validator result as that closed-loop proof.

Before `spec-candidate`, Phase 0 MUST produce a machine-readable inventory of
each independently falsifiable clause, its exact source/rationale, normative
location, compatibility class, and implemented test or approved manual
procedure. The candidate gate MUST fail on an umbrella-only clause, duplicate
definition, missing source mapping, missing oracle, or planned-only target.
