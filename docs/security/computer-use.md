# Computer Use Security

Status: Draft

This document applies Dolly's general `security-operations.md` and
`extension-process-protocol.md` contracts to graphical computer use. A virtual display
creates a trust boundary that must be enforced; it is not merely a test
dependency or an isolation mechanism by itself.

The current prototype has not demonstrated conformance with this document.
Until the required tests pass, computer use is an isolated development and
experiment capability and must not be presented as safe for public exposure or
unattended high-impact workflows.

## Protected assets

A computer-use deployment must protect:

- everything visible on the virtual display;
- browser cookies, storage, history, downloads, and profile state;
- typed text, clipboard data, screenshots, and accessibility data;
- Xauthority, browser control channels, and UI-driver handles;
- host files, network destinations, processes, and credentials;
- user confirmation and administrative authority; and
- action traces and audit evidence.

The principal adversaries are malicious web content, prompt injection, a
compromised model/provider, a malicious extension, another local OS user, an
unauthenticated remote viewer, and ordinary crash/restart races.

## X11 isolation

An X11 client holding the session authority can observe keystrokes, inject
input, inspect windows, and capture the whole display. Therefore:

- every Dolly security domain uses a dedicated display and service account;
- the Xauthority file is generated per session generation, stored in a `0700`
  runtime directory, and readable only by that account;
- Xvfb starts with `-auth`, `-nolisten tcp`, and without `-ac`;
- display and authority values are granted only to the trusted desktop, browser,
  and host-owned UI broker;
- a model or ordinary extension never receives the authority file or raw X11
  connection; and
- a recovered supervisor never deletes a display socket or authority file until
  it proves ownership and process generation.

`-ac` is forbidden because it disables access control. A firewall is defense in
depth, not a substitute for `-nolisten tcp` and Xauthority.

The virtual display must not contain unrelated applications, a real user's
desktop, SSH agent, password manager, notification feed, or production browser
profile. X11 isolation within one display is not strong enough to separate
mutually untrusted applications.

## Browser boundary

The browser renders hostile content and must remain sandboxed:

- run the browser as the dedicated non-root service account;
- use the exact Playwright/Chromium revision tested with the Dolly release;
- explicitly enable Chromium sandboxing and fail closed if it is unavailable;
- never use `--no-sandbox` or run the browser as root;
- use a new owner-only profile for tests and experiments;
- expose DevTools only over a protected pipe or random loopback endpoint; and
- constrain navigation, downloads, uploads, clipboard, and local-file access by
  separate host policies.

Playwright process isolation is not a security sandbox by itself. The Chromium
sandbox, Dolly capability policy, OS identity separation, and, for untrusted
extensions, a passing platform sandbox backend are distinct controls.

Browser downloads are untrusted. The host must assign them to a bounded
instance-specific directory, reject path traversal and unsafe symlinks, limit
size/count, and prevent automatic execution. Uploads require an explicit
workspace capability; a model-supplied path is never sufficient authority.

## Model and prompt injection

Text and images in a page may instruct the model to reveal data, change Dolly
configuration, open another site, run commands, or bypass user confirmation.
They are untrusted page content, not system instructions.

The model may propose only typed computer-use actions. The trusted host decides
whether the current capability authorizes an action and whether it requires
confirmation. Prompt wording such as "the user already approved" cannot create
authority.

The host must enforce finite action and episode limits independently of the
model, including:

- coordinate and payload bounds;
- screenshot dimensions, bytes, and rate;
- permitted applications, windows, URLs, and network destinations;
- maximum actions, retries, elapsed time, and concurrent sessions;
- cancellation and capability revocation; and
- confirmation for high-impact effects.

Unknown or ambiguous effects fail closed. A screenshot or page label is not
proof of an action's impact; use an independent validator or trusted application
integration where one exists.

## No general shell

A general shell executor is not a computer-use tool. It allows a model to read
same-user files, inspect processes, install or execute code, access ambient
credentials, change the display, and bypass every typed-action restriction.

`mcp-server-commands`, a shell MCP server, `bash -c`, or an equivalent command
bridge must not back the production computer-use capability. Adding an
`ALLOWED_COMMANDS` environment variable does not create a boundary unless the
specific implementation validates an immutable executable/argument policy and
passes escape tests. A system prompt asking the model to use only `xdotool` is
not enforcement.

If a workflow genuinely needs subprocess authority, it uses a separate narrow
capability with executable identity, fixed argument schema, working-directory
policy, resource limits, sanitized environment, confirmation rules, and audit.

## Secrets and session data

The UI broker and browser must not inherit the daemon's full environment.
Provider keys, storage credentials, Console sessions, SSH agents, signed media
URLs, and unrelated secret references are absent unless an individual operation
requires a narrowly scoped handle.

Screenshots, typed text, clipboard contents, URLs, and page titles may contain
secrets or personal information. Routine logs and audit events record metadata,
stable error codes, hashes, and bounded redacted summaries, not raw content.
Experiment artifacts use disposable accounts and synthetic data by default.

A live workflow must show the user when capture/control is active, which display
and browser profile are in scope, and how to stop it immediately. Revocation
invalidates outstanding handles and prevents late actions from a previous Module
or process generation.

## Remote observation

VNC/noVNC expands the trust boundary and is absent by default. If explicitly
installed for operator observation:

- x11vnc binds only to loopback, authenticates with an owner-only password file,
  and never uses `-nopw`;
- noVNC/websockify also binds only to loopback;
- the operator connects through authenticated SSH port forwarding or an
  equivalently protected private access layer;
- the ports are not published through a public firewall, reverse proxy, or
  automatic port mapping; and
- stopping Dolly does not accidentally leave observation services attached to a
  stale display generation.

VNC authentication is not Dolly Console authentication. A noVNC browser session
must not receive provider credentials or administrative cookies merely because
it originated from loopback.

## Required security evidence

Portable conformance tests must cover:

- forged, expired, revoked, replayed, and cross-session UI capability handles;
- unknown fields/actions, malformed coordinates, oversized text/screenshots,
  and stale display geometry;
- action, screenshot, retry, session, and deadline limits;
- denial of shell, arbitrary path, clipboard, upload/download, app launch,
  network, secret, and listener access without separate grants;
- late actions after stop, cancellation, restart, or Module generation change;
- artifact retention, deletion, redaction, and cross-instance isolation; and
- confirmation enforcement independent of model or UI wording.

Ubuntu 24.04 integration tests must additionally use real processes to prove:

- Xvfb has no TCP listener and does not use `-ac`;
- another unprivileged user cannot connect without the Xauthority cookie;
- browser sandboxing is active and `--no-sandbox` is rejected;
- the UI driver and browser environments contain no undeclared secrets;
- browser/profile permissions and per-instance separation hold;
- VNC/noVNC is absent or loopback-only; and
- process-tree cleanup, display-number collision, crash recovery, and authority
  rotation do not leave a controllable stale session.

Public or high-impact use remains unsupported until these tests pass on the
documented backend. A process boundary, successful screenshot, model response,
or private-server demonstration is not equivalent evidence.

## Legacy experiment warning

The old `test/experiments/computer-use-test.ts` and related JSON files violate
this design: they use a general command server, hard-coded display/provider
configuration, an unbounded safety timeout, unpinned `npx` package references,
a browser `--no-sandbox` option in one draft, and response keyword matching in
place of state validation. They are historical artifacts and must not be copied
into user documentation or cited as security evidence.
