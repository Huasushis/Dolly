# Computer Use Guide

Status: Draft

Computer use is the ability to observe and operate a bounded graphical session
through screenshots and typed UI actions. It is not permission to execute an
arbitrary host command. This guide describes the intended user-facing behavior;
the current legacy experiment does not implement this contract.

For the Ubuntu 24.04 headless setup, read
`docs/deployment/linux-headless.md`. Security requirements are expanded in
`docs/security/computer-use.md`.

## Trust model

Treat all of the following as untrusted:

- task instructions and web content;
- screenshots, accessibility text, clipboard data, and downloaded filenames;
- model reasoning, final output, and tool arguments;
- browser pages, dialogs, extensions, and remote content; and
- third-party Dolly extensions.

The trusted Dolly host owns the display session, Xauthority, browser process,
browser profile, screenshot ingestion, action validation, capability grants,
and audit events. An LLM or ordinary extension receives only the actions granted
for one session. It must not receive storage/provider secrets, the daemon's
environment, raw Xauthority, a browser DevTools endpoint, or a general shell.

Running an Extension in a separate process provides fault isolation, not an
operating-system sandbox. An Extension configured as `untrusted` may run only
with `sandbox` isolation, and only when the selected Linux sandbox backend
passes the platform tests in `docs/spec/extension-process-protocol.md`.

## Capability surface

A computer-use capability should expose a small versioned action set such as:

- capture the full display or an allowed rectangular region;
- move the pointer to bounded coordinates;
- click an allowed mouse button a bounded number of times;
- type bounded UTF-8 text;
- press an explicitly allowed key or key combination;
- scroll a bounded amount;
- list or focus windows within the owned display; and
- launch a configured browser or application from an administrator allowlist.

These names are illustrative until the public capability schema is accepted.
Each request must be schema validated before touching X11 or the browser. At a
minimum, a grant binds:

- Dolly instance, Module generation, session, and operation identity;
- display and browser profile identity;
- allowed applications, windows, and URL/network scope;
- coordinate space and current display dimensions;
- maximum text, screenshot, action, step, and episode sizes;
- action and episode deadlines;
- clipboard, upload, download, and workspace-file permissions; and
- expiry, revocation, and user-confirmation policy.

Unknown action types and unknown fields are errors. Invalid, expired, revoked,
cross-session, out-of-bounds, oversized, or replayed requests must fail closed.

## Denied by default

A computer-use grant does not imply permission to:

- run a shell command, subprocess, package manager, or `sudo`;
- read or write an arbitrary host path;
- connect to an arbitrary network destination or open a listener;
- access the user's normal browser profile, password store, SSH agent, or host
  clipboard;
- disable the browser sandbox or X11 authentication;
- retrieve provider or storage credentials;
- alter Dolly configuration, extensions, capability grants, or audit records;
  or
- operate another display or Dolly instance.

Filesystem, subprocess, secret, network, and administrative operations are
separate capabilities. Combining them in one generic command server defeats the
computer-use boundary.

## Session flow

A normal episode follows this bounded loop:

1. The host creates or resets an isolated display and browser profile.
2. The host registers the screenshot as one Dolly Media item and grants the
   model operation short-lived access to that same Media. Large image bytes do
   not travel in control frames.
3. The model proposes one typed action.
4. The host validates the action, capability, current generation, limits, and
   any required user confirmation.
5. The host performs the action and records a sanitized audit event.
6. The host captures post-action evidence and reports either a typed result or a
   stable failure code.
7. The loop stops on deterministic success, explicit user cancellation, action
   budget, episode deadline, capability revocation, or terminal error.

An action result means only that the broker attempted or completed the action.
It is not proof that the user's task succeeded. Task success comes from an
independent environment-state validator or explicit user confirmation.

All limits must be finite. `safetyTimeoutMs: -1`, an unbounded tool loop, or a
model-controlled deadline is not a supported production setting.

## Browser profiles and credentials

Use a disposable browser profile by default. Deterministic tests and model
benchmarks must never use a profile containing real cookies, passwords,
autofill, payment data, browsing history, or synchronized accounts.

A user may explicitly authorize a persistent profile for a real workflow only
after the UI explains that the model and every granted UI action can observe or
change anything visible in that profile. Persistent profiles require:

- owner-only filesystem permissions;
- an explicit site/network allowlist where feasible;
- a visible active-session indicator and immediate revocation control;
- confirmation for high-impact actions;
- bounded retention and a documented delete operation; and
- separate audit and incident-response policy.

High-impact examples include sending a message, publishing content, making a
purchase, changing authentication settings, uploading private data, deleting
remote data, accepting a legal agreement, or revealing a secret. Visual button
labels are not authorization boundaries; the host policy must classify and gate
the underlying action.

## Model and provider requirements

Pixel-based operation requires a model endpoint that declares image input
support. A text-only model may participate only through a separately specified
and tested accessibility/DOM representation; Dolly must not claim that such a
model inspected a screenshot.

Provider behavior is described per endpoint/model operation, not inferred from
a provider family name. In particular:

- support for an `enable_thinking` request field must be declared explicitly;
- an always-reasoning endpoint that rejects that field must not receive it;
- non-empty returned `reasoning_content` is an observation for that response,
  not proof derived from configuration; and
- reasoning content remains separate from the visible answer and UI actions.

Owner-specific Aether, DashScope, OSS, model names, endpoints, and credentials
are optional live fixtures. Public computer-use configuration must work with
generic capability descriptors and deterministic local substitutes.

## Coordinate and screenshot behavior

The host defines one canonical pixel coordinate system for the current display.
Model-specific normalized coordinates are converted by an adapter before the
broker validates them. A resize, crop, display-scale, or browser zoom change must
produce a new observation identity; an action calculated against stale geometry
must be rejected or explicitly transformed under a tested rule.

Screenshots are sensitive media. The host must:

- enforce byte, pixel, frequency, and retention limits;
- avoid embedding them in logs, audit events, or IPC control frames;
- remove signed provider URLs and credentials from artifacts;
- preserve only the artifacts authorized by the run policy; and
- express a crop as a bounded request against the same Media identity; a resize
  or materialized derivative requires a separately specified operation.

## Headless and remote operation

Headless operation uses a dedicated authenticated Xvfb display and an
unprivileged sandboxed browser as described in the deployment guide. The display
must not be the operator's normal desktop.

VNC/noVNC is not required for AI operation and is absent by default. When an
operator enables observation, both services remain on loopback and are reached
through an authenticated SSH tunnel. Remote observation does not grant Dolly
Console, model, extension, or administrative authority.

## How to evaluate the feature

Use `docs/experiments/computer-use-protocol.md`. First prove the display and
typed-action driver without any model. Then prove Dolly runtime cancellation,
recovery, capability denial, and artifact lifecycle. Only after those gates pass
should a live model attempt controlled tasks.

The historical `test/experiments/computer-use-test.ts` is not evidence of this
feature. It does not launch a meaningful target application, grants arbitrary
shell execution, uses response keyword matching instead of task-state
validation, has no reproducible browser revision, and lacks sufficient traces,
screenshots, repetitions, baselines, and safety checks.
