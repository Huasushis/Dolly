# Linux Headless Deployment

Status: Draft

This guide defines Dolly's supported headless desktop baseline for Ubuntu 24.04
LTS. Linux is the primary release-validation platform. Windows remains a
secondary development platform, and a private server is never the sole
correctness oracle.

The current source tree does not yet ship a production computer-use broker,
reviewed systemd units, or a pinned Playwright browser dependency. The operating
system setup below is the target deployment contract, not a claim that the
legacy experiment is production-ready. Do not expose the legacy Console or its
computer-use experiment to an untrusted network.

## Deployment shape

A supported deployment separates these roles:

1. A dedicated operating-system account owns one Dolly computer-use session.
2. Xvfb provides an authenticated, non-networked X11 display.
3. A small explicit set of XFCE components provides a window manager, panel,
   desktop, file manager, terminal, settings, and notifications.
4. A host-owned computer-use broker controls the display and browser. Model and
   extension processes receive typed capabilities, not Xauthority or a shell.
5. A version-locked Chromium build runs as the unprivileged service account with
   its sandbox enabled.
6. VNC or noVNC is absent by default. Optional human observation is loopback-only
   and reached through SSH port forwarding.

One X display, Xauthority file, browser profile, and artifact directory belong
to exactly one Dolly instance. Do not share them with an interactive desktop or
another instance.

## Prerequisites

The intended release baseline is:

- Ubuntu Server 24.04 LTS;
- an administrator able to install packages;
- a non-root Dolly installation, for example under `/opt/dolly`;
- systemd for a persistent service, or a foreground process for an ephemeral
  experiment;
- a Python 3 interpreter when the deployment runs executable Modules, because
  the reviewed child launcher required by Architecture Decision Record 0009
  must join a control group, set its own open-file limit, and replace its own
  process image without forking, which the installed Node.js runtime cannot do;
  and
- enough memory and disk for Chromium profiles and screenshots.

A host with 15 GiB of RAM is normally sufficient for one XFCE/Xvfb/Chromium
session, but browser workload determines the real peak. Start with one active
computer-use episode per host and measure `free -h`, `/dev/shm`, process count,
and disk growth before increasing concurrency.

Public instructions must not assume passwordless `sudo`. Administrative package
installation and routine unprivileged operation are separate steps.

## Install the desktop baseline

Use explicit components instead of installing an entire desktop distribution or
display manager:

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends \
  ca-certificates \
  xvfb xauth dbus-x11 \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf \
  xfce4-appfinder \
  thunar xfce4-terminal xfce4-notifyd \
  x11-utils x11-xserver-utils xdotool wmctrl scrot xclip \
  fonts-dejavu-core fonts-noto-cjk adwaita-icon-theme
```

`xdotool`, `wmctrl`, and `scrot` are useful for infrastructure conformance. They
must not be exposed to an untrusted model through an arbitrary command runner.

The baseline intentionally omits:

- LightDM, GDM, and other graphical login managers;
- screen lockers and XFCE power management, which can blank an unattended
  virtual display;
- VNC and noVNC;
- a general shell MCP server; and
- a system browser whose version can change independently of Dolly's tested
  release.

Before publishing a release, verify every package name against the Ubuntu 24.04
repositories on both supported CPU architectures. Installation tooling should
offer a check-only mode and fail before changing the host if a required package
is unavailable.

## Create the service identity

Use a dedicated locked service account. It must not have `sudo`, an SSH key, or
an interactive login shell.

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/dolly-cu \
  --shell /usr/sbin/nologin \
  dolly-cu
sudo passwd --lock dolly-cu
sudo chmod 0700 /var/lib/dolly-cu
sudo install -d -o dolly-cu -g dolly-cu -m 0700 \
  /var/lib/dolly-cu/state \
  /var/lib/dolly-cu/browsers \
  /var/lib/dolly-cu/profiles \
  /var/lib/dolly-cu/artifacts
```

If the account already exists, inspect it instead of recreating it. A packaged
installer must be idempotent and must never change an existing account's home,
groups, or shell without explicit operator approval.

Use one account per security domain. Separate accounts are recommended when
instances access different credentials or untrusted sites. A service account is
useful containment, but it does not by itself provide `sandbox` isolation for
an Extension.

## Virtual display requirements

The persistent display supervisor must create a fresh Xauthority cookie in an
owner-only runtime directory for every session generation, then start Xvfb with
equivalent arguments to:

```text
Xvfb :99 \
  -screen 0 1280x800x24 \
  -dpi 96 \
  -nolisten tcp \
  -noreset \
  -auth /run/dolly-cu/Xauthority
```

`:99` is an example, not a fixed requirement. The supervisor must detect a
collision and choose or allocate a display number without deleting another
process's socket. It must export both `DISPLAY` and `XAUTHORITY` only to the
trusted desktop, browser, and computer-use broker.

Never use `-ac`. It disables X11 access control and lets other local clients
connect without the session cookie. Do not omit `-nolisten tcp`; relying on a
distribution default is not sufficient evidence that X11 is private.

For a one-shot CI or experiment session, `xvfb-run --auto-servernum` is preferred
because it allocates a display and temporary authority file. Its server
arguments must still include the fixed screen geometry, `-nolisten tcp`, and
`-noreset`. A release must ship a supervised session command rather than asking
users to assemble background processes with `&`.

## Start XFCE

Start XFCE inside a fresh D-Bus session owned by `dolly-cu`:

```text
dbus-run-session -- startxfce4
```

The service manager must provide `HOME=/var/lib/dolly-cu`, a private
`XDG_RUNTIME_DIR`, `DISPLAY`, `XAUTHORITY`, and a UTF-8 locale. It should disable
screen blanking for that virtual display and disable XFCE compositing when the
tested screenshot path requires deterministic pixels.

The packaged session must disable XFCE's automatic SSH and GPG agents and must
not pass through an operator's `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, or equivalent
credential sockets. The `dolly-cu` account deliberately uses `nologin`; a
terminal emulator is not an authorized shell capability and should not appear
in the computer-use application allowlist.

A persistent unit must also:

- order desktop startup after Xvfb readiness, not after a fixed sleep;
- use `KillMode=control-group` or equivalent so browser and desktop descendants
  cannot survive a stop;
- use `UMask=0077` so screenshots, browser profiles, authority files,
  downloads, and traces are owner-only even when an individual tool has
  permissive defaults;
- apply finite startup, stop, restart, process, and memory limits;
- rotate the Xauthority cookie after a restart;
- keep runtime files outside the source checkout; and
- expose no TCP listener as a side effect of starting the desktop.

Do not claim a persistent server setup is supported until the packaged unit and
its crash/restart behavior pass Linux integration tests.

## Install a locked browser

Dolly releases that support computer use must declare an exact Playwright
version in the package manifest and lockfile. The corresponding Chromium
revision is part of the release evidence. Do not use `npx`, `@latest`, a floating
semver range, or an unreviewed runtime download.

After installing Dolly with a frozen lockfile, an administrator may install the
audited browser system dependencies using the release-local Playwright binary.
The browser itself should be downloaded as `dolly-cu`, into its dedicated path:

```bash
sudo /opt/dolly/node_modules/.bin/playwright install-deps chromium
sudo -u dolly-cu env \
  HOME=/var/lib/dolly-cu \
  PLAYWRIGHT_BROWSERS_PATH=/var/lib/dolly-cu/browsers \
  /opt/dolly/node_modules/.bin/playwright install chromium
```

These commands are valid only for a release that actually contains the pinned
Playwright dependency. Review the lockfile and package provenance before
running a package-provided helper as root.

The trusted browser launcher must use headful mode on the virtual display and
explicitly enable Chromium sandboxing, for example through Playwright's
`chromiumSandbox: true` option. It must run as `dolly-cu`, never root. The
following are not acceptable workarounds:

- `--no-sandbox`;
- silently disabling sandboxing after a launch failure;
- exposing a DevTools port on a non-loopback address; or
- reusing a developer's normal browser profile.

If the sandbox cannot start, fix the host's namespace/kernel policy or report
the capability unavailable. A dedicated OS user does not replace the Chromium
sandbox.

Use a new disposable profile for every deterministic test and model experiment.
A persistent profile containing real cookies, passwords, or browsing history is
an explicit user feature with a separate threat review; it is never a benchmark
default.

## Verify the base session

Before running Dolly or a model, collect deterministic infrastructure evidence:

1. `xdpyinfo` succeeds with the intended `DISPLAY` and `XAUTHORITY` and reports
   the configured geometry and 24-bit screen.
2. `wmctrl -m` identifies the expected XFCE window manager.
3. A screenshot is valid PNG data, has the expected dimensions, and is not a
   uniform blank image. The automated check should use decoded pixels, not file
   existence alone.
4. A headful Chromium window can load a loopback-only fixture and render Latin
   and CJK text.
5. Chromium starts with the tested sandbox enabled. Absence of a
   `--no-sandbox` argument alone is not proof; the release test must inspect the
   browser sandbox status.
6. `ss -ltnp` shows no X11 TCP listener and no unexpected VNC, noVNC, DevTools,
   Console, or administrative listener.
7. The browser and UI driver environment contains no provider, storage, or
   Console credentials that their capability does not require.

Then run the deterministic UI test in
`docs/experiments/computer-use-protocol.md`. A live model run is not an
infrastructure test.

## Optional human observation

AI operation does not require VNC. Install remote-viewing packages only when an
operator needs to observe or debug the virtual desktop:

```bash
sudo apt-get install --no-install-recommends x11vnc novnc websockify
```

The optional services must be disabled and stopped after installation. When an
operator explicitly enables them:

- `x11vnc` attaches to the instance display using its Xauthority file;
- it binds only `127.0.0.1:5901`, uses an owner-only password file, and never
  uses `-nopw`;
- websockify/noVNC binds only `127.0.0.1:6080` and connects to the loopback VNC
  port; and
- neither port is opened in a public firewall or reverse proxy.

From the operator workstation, create an SSH tunnel:

```bash
ssh -N -L 6080:127.0.0.1:6080 user@example-server
```

Then open `http://127.0.0.1:6080/vnc.html` locally. SSH authenticates and
encrypts the transport. The VNC password remains required as defense in depth.
Binding VNC/noVNC to `0.0.0.0` or `::` is unsupported even when a password is
configured.

The Dolly Console has its own authentication contract. Access to an SSH tunnel
or noVNC session must not be treated as Console authentication.

## Operations and teardown

Normal stop must terminate Dolly, the browser, XFCE, D-Bus, Xvfb, and optional
observation processes as one supervised generation. Verify there are no
remaining processes owned by `dolly-cu` and no listeners on the display, VNC,
noVNC, DevTools, or Dolly ports.

For permanent removal:

1. stop and disable the packaged Dolly headless and optional observation units;
2. confirm that no other instance uses the service account or its directories;
3. export any state or audit evidence the operator intends to retain;
4. remove disposable browser profiles, browser binaries, screenshots, and state
   through the packaged uninstall command; and
5. remove the locked account and optional packages only after reviewing the
   resolved paths.

Published uninstall tooling must print the exact absolute targets and refuse a
workspace root, `/`, a home-directory parent, a symlinked state directory, or an
unrecognized owner. Do not publish a broad recursive-delete command as a setup
shortcut.

## Known unsupported shortcuts

The historical files under `test/experiments` are not deployment instructions.
In particular, the old setup:

- starts only Xvfb and no real desktop/browser target;
- hard-codes `DISPLAY=:1` and a private provider;
- grants an LLM arbitrary shell execution through `mcp-server-commands`;
- references unpinned or unverified package names through `npx`;
- includes a browser `--no-sandbox` setting; and
- treats response keywords as proof of UI actions.

It is historical evidence of an attempted experiment only. It must not be used
to claim Linux, browser, security, or computer-use support.
