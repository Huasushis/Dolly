# Computer Use Experiment Protocol

Status: Draft

This is a forward-looking protocol. It does not validate the historical
computer-use scripts or configurations in `test/experiments/`; their evidence
status is recorded in `docs/takeover/historical-experiment-materials.md`.

This protocol extends `docs/experiments/protocol.md` with evidence requirements
for graphical computer use. It separates deterministic code and infrastructure
tests from model capability experiments. A model benchmark cannot compensate
for a broken or unsafe UI driver.

Ubuntu 24.04 is the primary integration platform. The owner-authorized private
Linux server may run resource, isolation, soak, live-provider, and capability
experiments, but ordinary deterministic correctness tests must also run in local
development and public CI without that server or private services.

## Evidence levels

### CU0: installation and display smoke test

No model, provider, paid service, or private credential is allowed.

The test records package versions and proves that:

- the authenticated Xvfb display starts with a dynamically allocated identity,
  expected geometry, 24-bit color, `-nolisten tcp`, and no `-ac`;
- XFCE reaches readiness through a real window-manager probe;
- Latin and CJK text render;
- a screenshot decodes to expected dimensions and non-uniform pixels;
- the pinned headful browser launches with its sandbox active; and
- there are no unexpected X11, VNC, noVNC, DevTools, Console, or administrative
  network listeners.

File existence, a PID, a fixed sleep, or an LLM response does not satisfy CU0.

### CU1: deterministic UI-driver conformance

No model is allowed. Start a loopback-only versioned fixture in a disposable
browser profile. A deterministic client uses the same public typed capability
surface intended for models.

The minimum fixture contains:

- a text input and submit control;
- a scroll target outside the initial viewport;
- a tab, menu, or modal that changes observable state;
- a recoverable validation error;
- a drag or pointer-position task; and
- an optional file chooser rooted in a synthetic allowed workspace.

Each case has an evaluator inaccessible to the agent action channel. It inspects
fixture state, not response text. For example, a form case passes only when the
fixture stores the expected per-run nonce. The test retains pre-action and
post-action screenshot hashes plus the typed action trace.

CU1 must also exercise invalid coordinates, stale geometry, oversized text,
unknown actions, expired/revoked handles, deadline expiry, cancellation, and
denied shell/path/network/clipboard/app-launch requests.

### CU2: Dolly integration and fault recovery

Run CU1 tasks through the real Dolly runtime and capability broker. Use fake
model output or a scripted extension so behavior remains deterministic.

Cover at least:

- Module/process restart with new generation identity;
- late actions from the old generation;
- broker and browser crash during an action;
- X display loss and recovery;
- duplicate action/result delivery;
- cancellation during capture, input, and navigation;
- screenshot Media identity, crop reference, lifetime, and cleanup;
- bounded queues and backpressure; and
- complete process-tree cleanup on stop.

CU2 is the first level that provides Dolly runtime integration evidence. It is
still not a model capability claim.

### CU3: controlled model capability experiment

CU0 through CU2 must pass for the tested release/backend. A live run additionally
requires the opt-ins and finite call/time/spend budgets in the general experiment
protocol.

The model receives only the same typed UI capability used at CU1. It receives no
shell, evaluator endpoint, fixture source, direct DOM control, or answer key.
Every episode starts from a fresh browser profile and fixture state.

Use several task families rather than one four-step demonstration:

- form completion and correction;
- scroll and visual target acquisition;
- menus, tabs, dialogs, and focus recovery;
- table or grid editing;
- bounded file selection from a synthetic workspace;
- navigation among allowlisted local pages; and
- recovery from one intentionally introduced UI error.

Tasks must use synthetic data and local fixtures by default. Public websites are
not stable ground truth and may contain prompt injection or rate limits. A
separate adversarial-web set may be used only with an explicit threat boundary.

### CU4: comparative claim

Comparisons follow Gate 5 of the general protocol. Conditions use equal task
state, screenshot resolution, tool schema, action/step/time budgets, information,
and, unless it is the independent variable, model/provider configuration.

Use paired randomized order, isolated state, multiple repetitions, per-case
deltas, and uncertainty intervals. Do not tune prompts or thresholds on the
evaluation split. A single complete run is exploratory evidence, not a product
or architecture conclusion.

## Preregistration

Before CU3 or CU4, record:

- falsifiable hypothesis and simplest relevant baseline;
- task-set version, development/evaluation split, and fixture content hash;
- primary metric and minimum practically relevant effect;
- maximum calls, actions, steps, elapsed time, tokens, and spend;
- retry, cancellation, and intervention rules;
- random seeds and condition order;
- excluded cases and failure classification rules;
- data/privacy boundary and artifact retention; and
- stopping rule, including what triggers redesign and rerun.

Changing a prompt, model descriptor, coordinate adapter, screenshot transform,
tool schema, validator, or timeout after examining evaluation results creates a
new experiment version. Preserve the failed or neutral result.

## Deterministic success criteria

Every task has an independent machine-checkable terminal predicate. Examples
include an exact stored nonce, selected item ID, ordered list, dialog state,
download hash, or synthetic file content.

The following are not success criteria:

- the model says it clicked, typed, viewed, or completed the task;
- a response contains `screenshot`, `click`, `xdotool`, or the expected answer;
- a tool returned exit code zero;
- any screenshot file exists;
- a WebSocket connected; or
- the browser process remained alive.

The evaluator must not be callable by the model. When DOM/application state is
used as ground truth, its control channel is separate from the computer-use
action channel and its values are withheld until the episode ends.

## Required run manifest

In addition to the general experiment manifest, record:

- Ubuntu release, kernel, CPU architecture, and sandbox backend/version;
- Xvfb, XFCE component, Playwright, and Chromium versions/revisions;
- display geometry, depth, DPI, browser zoom, locale, and font package versions;
- browser sandbox result and redacted launch-policy hash;
- fixture version/hash and disposable profile identity;
- exact computer-use capability schema and grant-policy hash;
- model endpoint capability descriptor and exact model identifier;
- prompt, coordinate adapter, image resize/crop, and tool-schema versions;
- per-step observation ID, screenshot hash/dimensions, action request/result,
  validator state, latency, retry, and stable error code;
- episode termination reason and any human intervention; and
- source commit, dirty-worktree flag, config revision, random seed, and order.

Raw screenshots are optional sensitive artifacts, not routine logs. If retained,
store them in a bounded access-controlled artifact set with a deletion date.
Always retain enough hashes, state transitions, and sanitized traces to audit
aggregate metrics. Never retain credentials, signed URLs, real account data, or
private endpoint URLs.

## Metrics

Report at least:

- deterministic task success rate;
- first-attempt and eventual action success;
- invalid, denied, and unsafe action attempts;
- steps and screenshots per successful task;
- p50/p95 action and episode latency;
- timeout, crash, cancellation, and recovery counts;
- human intervention rate;
- token/call cost for live models; and
- screenshot bytes, artifact growth, and peak process/RAM use.

Safety denials are reported separately from driver errors. A denied unsafe action
does not become task success, and a permissive driver does not score better for
executing it.

## Failure analysis and iteration

Classify failures before changing the system:

- environment/display readiness;
- screenshot/media transport;
- visual perception or coordinate conversion;
- focus/window management;
- action execution;
- model planning/tool selection;
- validator/fixture defect;
- timeout/resource exhaustion;
- capability denial or unsafe proposal; and
- provider/network failure.

Fix deterministic environment, driver, or validator defects and rerun CU0-CU2
before spending more live calls. For model failures, update the preregistered
design, create a new experiment version, and rerun the full evaluation split.
Do not stop after the first weak run or report only successful episodes.

## Why the legacy experiment is not evidence

`test/experiments/computer-use-test.ts` and its old JSON configurations predate
this protocol. They cannot satisfy any evidence level because they:

- do not start a deterministic target desktop application or browser fixture;
- use `mcp-server-commands`, which grants arbitrary same-user shell execution;
- do not provide a reviewed typed computer-use capability;
- validate model response keywords instead of UI/application state;
- hard-code one display, port, private provider, and reasoning configuration;
- disable the scheduler safety timeout;
- contain unpinned or unverified runtime package references and one
  `--no-sandbox` browser setting;
- collect no sufficient screenshot, action, sandbox, environment, or state
  evidence; and
- have no baseline, repetitions, randomization, uncertainty, or meaningful
  stopping rule.

Those files may remain as clearly labeled historical artifacts, but their
reported connectivity or timeouts must not appear in a support matrix,
benchmark claim, security statement, or release criterion.
