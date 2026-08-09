# Scheduler-driven general Agent live effect

Status: exploratory effect supported by one complete replacement run. Product Module startup remains rejected.

## Result

Run `live-v8-20260809b` completed the registered two-condition comparison through the real owner-provided Aether deployment and passed the independent verifier.

| Condition | Observed action sequence | Result |
| --- | --- | --- |
| No storage capability | `answer` | The Agent reported that it had no evidence or tool access, set `grounded=false`, returned no evidence keys, and did not guess the hidden codename. |
| Read-only private storage | `storage.list → storage.get → answer` | The Agent returned `EMBER-7421`, set `grounded=true`, and cited `deployment-note`. |

The treatment planning call used `thinking.type=enabled`; its normalized response contained non-empty `reasoning_content`. The baseline and two continuation calls used disabled reasoning and reported no observed reasoning. All four provider calls completed with one provider attempt each.

The committed case evidence also records:

- Scheduler completion for both cases: no pending input Delivery, exactly one output Delivery, and no remaining Module submission;
- the two recorded Extension child processes were stopped before each case was accepted;
- neither Extension environment contained `AETHER_BASE_URL` or `AETHER_API_KEY`;
- all four provider secret leases were released;
- the artifact scan found neither configured private value;
- product bootstrap still rejects configured Modules;
- no delegated Linux control-group attachment or group-stop proof was claimed.

The independent verification result is `valid=true`. Raw provider responses, normalized model calls, case rows, the manifest, and verification output are retained under `artifacts/experiments/probes/general-agent-live-v0/runs/live-v8-20260809b/`.

## What ran

This was not a standalone toy loop. The candidate vertical chain used these existing Dolly boundaries:

1. `FileCoreStateStore` committed the external task Block and input Delivery.
2. `ModuleScheduler` drove one `ReactiveModuleRuntime` through `ReactiveModuleHost`.
3. A real `ExtensionProcessHost` child received a closed `module.execute` request.
4. The child could invoke only Host-issued model and private-storage capability handles for the active Run.
5. The Host injected the verified Module job, Run, attempt, and deadline; the child did not supply attempt or provider credentials.
6. `ChatModelBroker` selected the registered descriptor and endpoint binding, leased the Aether secret, and normalized the response.
7. The child used the tool observations in later model turns and proposed one result Block.
8. The result commit path atomically published the output Delivery and acknowledged the input Claim.

The product `openDollyRuntime()` path did not call this candidate composition and its `RUNTIME_MODULE_MIGRATION_REQUIRED` refusal was not removed or bypassed.

## Falsifying iterations retained

The successful run was not selected by silently retrying failed cases. Each changed assumption received a new experiment version; old artifacts were preserved.

- Initial static imports resolved `src/` relative to `scripts/`; no run or provider call began. The path was corrected and import preflight moved before run artifact creation.
- Descriptor preflight rejected two real contradictions: a non-streaming model declared a stream decoder, then its reasoning observer still declared a streaming strategy.
- Candidate process-record creation rejected a human-readable fake `serviceInvocationId`; the fixture now uses a syntactically valid 32-hex value while still reporting `linuxControlGroupProof=false`.
- `live-v1-20260809g` showed that the production pinned-DNS transport could not reach this fixture in that run. A later transport audit found that its pinned lookup returned the single-address callback shape even when Node 20 requested `all:true`; therefore that failure does not prove a proxy was required. The effect experiment uses a bounded, no-redirect `fetch` transport and explicitly does not claim either the corrected production direct path or production proxy support.
- Aether returned two measured response envelopes across retained runs: a relay envelope from the Memory v9 evidence and an OpenAI-top-level envelope with Aether provider-specific choice/message fields in the current run. Response strategy `aether.qwen.chat.response.v2` accepts exactly those two closed variants and rejects unknown hybrids.
- The model sometimes wrapped its sole JSON object in a `json` code fence. The Agent adapter accepts either bare JSON or one code fence with no surrounding text; it does not search arbitrary prose for JSON.
- `live-v6-20260809a` selected the correct `storage.list` action but requested `limit=20`, exceeding the enforced maximum of 8. The next version supplied the exact closed tool argument contract. This exposes a product design requirement: capability descriptors need machine-readable input schemas and limits instead of handwritten prompt text.
- `live-v7-20260809a` failed before receiving a provider body. `live-v8-20260809a` completed `list → get` but its final provider response failed in transit. Version 8 registered at most one fresh replacement run after infrastructure failure, preserving and never merging the failed run. The sole replacement was `live-v8-20260809b`.

These failures initially looked like a slow lifecycle path, but the retained Core state disproved that interpretation. A capability-mediated Run with `core-capabilities-only` effects and no complete persistent effect evidence must not be retried or dead-lettered after a provider failure: Runtime correctly returns `recovery-required`, Scheduler correctly quarantines the Module, and the active Claim remains fenced. The defect was the experiment waiter, which observed only commits and dead letters and therefore ignored this known safe terminal state until its 420-second timeout. The waiter now observes Scheduler quarantine and immediately reports its exact reason; it does not relabel an unknown external-effect outcome as a dead letter.

## Supported and unsupported conclusions

Supported:

- one Scheduler-driven, process-isolated candidate Module can plan with the configured Aether model, invoke Host-granted tools, consume their observations, and commit a grounded answer;
- URL/key ownership can remain in Core while a child Agent receives neither value;
- the owner deployment accepts `thinking.type`, and only non-empty returned reasoning proves reasoning for the treatment planning call;
- endpoint/model-specific response adaptation is necessary for this Aether deployment;
- the existing Scheduler, Delivery/Claim, capability, broker, and result-commit components can form a real pre-product vertical chain.

Not supported:

- product Module startup or removal of the migration refusal;
- Linux delegated control-group ownership, whole-group termination proof, or durable stopped-record closure;
- production proxy support in `NodeModelHttpTransport`;
- durable model-effect deduplication after a Core or Extension process restart;
- aggregate per-Run token, byte, time, and cost budgets for a long-lived model capability;
- broad task generality, reliability across repeated seeds, or a benchmark improvement;
- a final Memory architecture.

## Engineering decisions changed by the demo

1. Keep `ModuleScheduler` and `ReactiveModuleRuntime` as the main runtime line; do not revive the legacy Scheduler/Orchestrator.
2. Make capability tool contracts machine-readable and inject them into Agent context. A name-only tool list is insufficient.
3. Keep endpoint/model response strategies explicit. Do not weaken the generic OpenAI decoder to accept arbitrary extra fields.
4. Add an approved proxy-capable production model transport without surrendering destination and response bounds.
5. Preserve fail-closed quarantine for unknown external-effect outcomes, make every waiter surface it promptly, and require a persistent complete effect-intent/outcome journal before any such failure can become safely retryable or dead-lettered.
6. Before product integration, close per-Run budget accounting, request-ID uniqueness, generation/handle rotation, and durable idempotency evidence.
7. Use the independently supported, source-citing structured task checkpoint as the first simple Memory behavior. Keep association, recurrence, summarization, and procedure factors in independent experiments rather than baking them into the first product Memory design.

The next effect slice is task interruption and resumption: persist a sourced checkpoint, switch to an unrelated task, remove the first task from active context, then let the same Scheduler-driven Agent retrieve the checkpoint and continue. This remains a candidate composition until the Linux lifecycle boundary is proven.
