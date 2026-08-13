# Browser Tool Evaluation Specification

Status: **Experimental verification track**. Passing a public browser benchmark
does not establish Dolly tool safety or Core correctness.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative for this track.

`REQ-BROWSER-001` — Before BrowserGym/WebArena or open-web evaluation, the
Camoufox-plus-MCP path MUST pass a self-hosted, deterministic conformance suite
for screenshot, DOM/accessibility inspection, click, form, download, navigation,
timeout, and restart behavior.

`REQ-BROWSER-002` — Browser outcomes MUST be judged from frozen page/server
state and captured artifacts, not model self-report; the run MUST pin browser,
MCP adapter, OS/image, locale, fonts, viewport, clock, network, and task revision.

`REQ-BROWSER-003` — Treatments MUST share task state, model, tools, permissions,
retry policy, and budgets and MUST include hostile content, redirects, popups,
downloads, stale elements, and partial/unknown tool outcomes.

`REQ-BROWSER-004` — Promotion requires state-verified held-out success and
non-inferiority for security, screenshot fidelity, tool protocol correctness,
recovery, latency, and cost; a benchmark aggregate cannot average away an
authorization or unknown-outcome violation.

## 1. Layered harness

Evaluation proceeds in this order:

1. local static pages with exact DOM, accessibility, HTTP, and download oracles;
2. local scripted applications with state changes, popups, redirects, and
   deterministic failures;
3. recorded or isolated dynamic sites;
4. pinned BrowserGym/WebArena tasks; and
5. bounded open-web smoke tests, which are diagnostic only.

A later layer MUST NOT be used to waive a failure in an earlier layer. The
local server starts from an immutable snapshot for every run and records final
database state, request log, response bodies/digests, and downloaded artifacts.
The browser profile is new or restored from a declared snapshot; undeclared
cookies, cache, credentials, extensions, or service workers are forbidden.

## 2. Required operation corpus

The plan `track` is `browser_tools` and MUST include `screenshot`,
`dom-or-accessibility-tree`, `click`, `form`, `download`, and `hostile-content`.
The self-hosted corpus MUST exercise:

- full-page and viewport screenshots, scrolling, clipping, DPR, and image
  dimensions/media type;
- DOM or accessibility-tree labels, hidden/disabled elements, iframes, shadow
  roots where supported, and stale element handles;
- single/double click, keyboard input, select, checkbox, submit, upload policy,
  navigation, and back/forward behavior;
- downloads with filename collision, MIME mismatch, large/slow responses,
  interruption, and digest verification;
- alert/popup, cross-origin redirect, authentication boundary, timeout,
  browser/MCP crash, and reconnect; and
- prompt injection, misleading overlays, clickjacking-like layout, data/file
  URLs, SSRF targets, and attempted credential or capability exfiltration.

Unsupported operations MUST return a typed result. A timeout or lost response
after a state-changing browser action is an unknown outcome and MUST be
reconciled from page/server state before retry; blind replay is forbidden.

## 3. Screenshot and state oracle

The primary oracle is final application/server state plus exact downloaded
artifact digests. For a pinned rendering environment, screenshots MUST record
PNG digest, dimensions, viewport, DPR, scroll position, clipping rectangle,
browser build, and capture-call revision. Exact pixel equality MAY be required
for synthetic pages. When platform rendering cannot be bit-exact, the plan
MUST freeze a perceptual comparison algorithm, threshold, masks, and golden
revision before held-out runs; masks cannot cover task-relevant content.

DOM/accessibility snapshots and screenshots are complementary. The harness
MUST include cases where one is stale or omits task-relevant information. A
model claim that it clicked or saw an element is not evidence; tool trace plus
state/artifact oracle decides the result.

## 4. Fairness, metrics, and gate

The baseline and treatment use identical model profiles, task snapshots,
viewport, tool surface, permission envelope, call/token/tool/time/cost budgets,
and retry policy. If a framework exposes a materially different tool surface,
the difference is documented as a treatment and reported on a quality-cost
frontier rather than hidden behind adapters.

Required metrics are state-verified task success, per-operation validity,
screenshot fidelity, stale-handle recovery, unknown-outcome reconciliation,
download integrity, unauthorized attempt/success, prompt-injection success,
tool calls, retries, tokens, wall time, and cost. Results MUST be stratified by
operation and failure class. Any credential disclosure, policy bypass, unsafe
retry, or unbounded download is an absolute failure.

Only after the local suite passes may a fixed BrowserGym/WebArena revision be
reported. Public benchmark contamination, external-site drift, and unavailable
tasks MUST be disclosed and cannot be silently replaced.

