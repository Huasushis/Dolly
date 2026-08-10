# Camoufox browser control through MCP: contained Linux confirmation

Date: 2026-08-10

Preregistration: `docs/experiments/preregistrations/camoufox-mcp-v2.json`

Confirmation run: `artifacts/experiments/probes/camoufox-mcp-v0/confirmation-v2-20260810a`

## Decision

Keep the exact-version Camoufox path through Model Context Protocol (MCP) as a candidate browser tool adapter on Linux. Keep direct Camoufox control as the deterministic baseline.

This decision is narrow. It proves that a real MCP client can drive a real Camoufox browser for the frozen local task. It does not prove a model can plan arbitrary browser work, that arbitrary websites work, that browser effects are safely authorized or recoverable, that other operating systems work, or that Dolly supports browser Modules. `RUNTIME_MODULE_MIGRATION_REQUIRED` remains in force.

## Result

The independently verified result was:

| Control path | Complete cases | Screenshots | Planned missing-target errors | Same-session recovery | Recorded processes left |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct Camoufox Python API | 3/3 | 6/6 | 3/3 | 3/3 | 0 |
| MCP SDK → Playwright MCP → Camoufox | 3/3 | 6/6 | 3/3 | 3/3 | 0 |

Each MCP case made 14 real tool calls. Across the three cases, the required tool inventory was present and every required operation was successfully exercised: navigation, accessibility snapshot, screenshot, text input, click, page evaluation, explicit downward scroll, and continued operation after the planned error.

MCP output containment also passed. Repository-root `.playwright-mcp` was absent before and after the matrix. Each MCP repetition produced exactly two MCP-owned PNG files under its own `mcp-internal/rN` directory; their hashes exactly matched the two separately retained screenshots from that repetition.

All 12 screenshots were 800×600 PNG files. The verifier checked three exact RGB anchors in each top image and three in each bottom image with zero tolerance. A separate visual inspection showed the expected `VISUAL-CODE-7391` header at the top and the Bottom/Recover area after scrolling. PNG hashes were intentionally not used as the visual equality oracle: the page contains a fresh `pageTimeOrigin`, so otherwise-correct top images differ byte-for-byte.

Median-like timing is not inferred from three cases and was not a decision metric. Diagnostic wall times were about 4.1 seconds per direct case and 12.4–12.7 seconds per MCP case.

## Compatibility result

The working stack was exact, not merely “Playwright 1.60 compatible”:

- Camoufox Python 0.5.4
- Camoufox browser 152.0.4-beta.28
- Python Playwright 1.60.0
- `@playwright/mcp` 0.0.74
- MCP-side `playwright` 1.60.0
- MCP-side `playwright-core` 1.60.0
- MCP SDK 1.30.0

`@playwright/mcp` 0.0.74 normally declares a Playwright 1.60 alpha build. The confirmation dependency lock overrides both Playwright packages to stable 1.60.0, matching the Python server. The release artifact digest and the installed executable digest are recorded separately; they are not the same object.

Development runs produced useful counterexamples and were not relabeled as confirmation evidence:

- MCP 0.0.79 used a Playwright 1.63 client and the 1.60 server rejected it with HTTP 428.
- MCP 0.0.74 did not accept the later `--timeout-settle` option.
- A remote `launch_server` browser has no initial context; omitting `--isolated` caused MCP to use an undefined context.
- MCP 0.0.74 with its declared 1.60 alpha dependencies reached the stable server but failed on the extra `Electron` protocol initializer.
- After the wire path worked, a runner parser incorrectly treated a JSON-encoded string as an object. That run was preserved, the parser was made strict, and a new run directory was used.
- The first 6/6 confirmation wrote otherwise-valid MCP snapshots and duplicate screenshots to repository-root `.playwright-mcp`. Those files were preserved under `artifacts/experiments/probes/camoufox-mcp-v0/escaped-mcp-output-through-20260810a`; the run was excluded from the architecture decision, output routing was frozen, and all six cases were rerun.

These failures change the engineering choice: a browser adapter must validate the exact client/server protocol set at installation or startup. Comparing only nominal major/minor versions is insufficient.

## Evidence quality

The final confirmation was frozen after development and the output-boundary counterexample, and before its six new browser cases. `run.json` records the Git object, preregistration and implementation hashes, package versions, package metadata hashes, dependency-lock hash, release digest, executable digest, and fixed case plan.

The independent verifier does not import runner code. It checks source bytes, JSON Lines ordering and semantic events, exact state transitions, MCP inventory and exercised calls, screenshots, local-only networking, process finalization, output containment, exact artifact inventory, and orchestration exits. Eight targeted mutations were independently rejected:

- wrong action count;
- wrong anchor pixel even after updating that PNG's recorded size and hash;
- missing required MCP tool;
- a recorded process left at finalization;
- changed implementation hash;
- an undeclared extra artifact;
- a missing MCP-owned output;
- a false repository-root output-containment proof.

The generated `sha256sums.txt` was independently rechecked from its own run directory after verification; all 27 listed files matched. An earlier check from the repository root failed because relative manifest paths were resolved from the wrong directory and was not treated as artifact failure.
The separate mutation audit is retained at `artifacts/experiments/probes/camoufox-mcp-v0/verifier-audit-v2-20260810a/result.json`, including the verifier and mutation-checker source hashes.

## Engineering consequence

The effect requested by the owner—Camoufox through MCP can take correct screenshots and perform interactions—now has real, falsifiable Linux evidence. The next product step is not to call the development script from Dolly directly. It is to expose a bounded browser tool through the same host-owned tool description, approval, deadline, byte-limit, active-Run, and durable effect rules as other tools. Until those boundaries and the installed Linux Module composition are closed, this remains a candidate adapter and must not bypass the Module startup refusal.

This experiment made no model request. The separate general Agent and task-switch experiments use strict server-sent event streaming; the browser result here therefore adds no non-streaming LLM exception.
