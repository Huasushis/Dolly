# Linux Core service process ownership experiment runbook

Status: Draft; catalog version 5 enumerates 570 cases, one of them exclusive, and every catalog
entry resolves to an existing handler file. That file check does not establish that the full
matrix passes.

This runbook explains how to prepare an environment for the preregistered experiment in
`linux-core-service-process-ownership.md` (protocol version 3), how to run the harness, where its
artifacts go, how to read a failure, and how to leave the machine with nothing behind.

The harness lives in `scripts/experiments/linux-core-service-ownership/`. It touches no product
source: it starts services under a reserved name prefix, observes them, and removes exactly what it
created.

## What exists today

- `run.sh` — the runner. It checks the environment, writes the manifest, walks the ordered case
  list, cleans up, and writes the machine-readable summary.
- `lib/catalog.mjs` — catalog version 5, with 570 cases. Every case names the protocol or
  Architecture Decision Record (ADR) clause it comes from, so the enumeration can be audited
  clause by clause. One case, `SC-03-02-user-manager-restart`, is marked `exclusive`.
- `lib/manifest.mjs` — writes `manifest.json` and the ordered case list the runner iterates.
- `lib/summarize.mjs` — writes `summary.json` and decides the run verdict.
- `lib/safety.sh` — inventory and cleanup helpers, including every rule from the protocol's
  "Safety and cleanup" section.
- `handlers/` — the case handlers and their supporting programs. All 570 catalog entries currently
  resolve to a handler file.

Handler-file resolution is only a static completeness check. It does not show that a handler
exercises the required product boundary, retains every required artifact, or passes in either
service scope. Those claims require the recorded Linux runs and per-case results described below.
If a selected handler file is missing in a future revision, the runner still records that case as
`inconclusive` with the reason `case-handler-not-implemented`.

## Environment requirements

The full matrix requires a **disposable** Linux virtual machine or container, because several cases
restart the service manager, end login sessions, and reboot the machine.

- **Linux kernel 5.15 or newer**, pinned for the run. `cgroup.kill` needs 5.14; the manifest
  records the exact release.
- **systemd 254 or newer**, pinned for the run. `DelegateSubgroup`, `RestartMode`, and
  `systemd-run --expand-environment=` first appear in 254; `ExitType` needs 249, and ADR 0009
  requires all four behaviors.
- **Control group version 2** mounted at `/sys/fs/cgroup`, with explicit delegation.
- **`cpu`, `memory`, and `pids` controllers** delegable, because the required limits are written
  into the delegated groups and read back.
- **Node.js 20 or newer.** Dolly Core and this harness both run on Node.js.
- **Python 3.8 or newer** with no third-party import, for the ADR 0009 child launcher.
- **bash 4.3 or newer.** The harness uses name references.
- **`systemctl`, `loginctl`, `timeout`, `find`, `pgrep`, and `git`** for environment facts,
  deadlines, and the inventory.

Additional requirements the runner cannot check for you:

- a fresh service account and an empty Dolly state directory;
- permission to restart the service manager, end login sessions, and reboot;
- user lingering enabled when the run uses the user service scope; and
- no provider, object storage, owner credential, private endpoint, or paid interface. The
  experiment must not need any of them, and the manifest records `backendKind: "local"` with no
  fake substitute.

Run the complete matrix once for each supported service scope (`--service-mode user` and
`--service-mode system`), from two independently created clean environments each. The protocol's
stopping rule is not met until all of those runs pass.

## What may run on the USTC server, and what may not

The authorized University of Science and Technology of China (USTC) server is a shared machine. It
is **not** disposable. It may run only cases the catalog marks non-disruptive, at user service
scope, under the profile that enforces exactly that:

```sh
# Preview the permitted selection without running handlers.
bash scripts/experiments/linux-core-service-ownership/run.sh \
  --profile ustc-non-disruptive --list
```

The profile forces `--non-disruptive-only`, refuses the system service scope, and refuses to be
combined with `--disposable`. Independently of the profile, the runner refuses to start when the
selection contains any disruptive case and `--disposable` was not given.

The earlier example used `--profile ustc-non-disruptive --mode smoke` as a harness self-check.
That claim is awaiting review: smoke mode still requires every selected result to be
`inconclusive`, while all selected catalog entries now resolve to handlers that may return other
statuses. Do not quote a smoke invocation as a passing harness check or as experiment evidence
without a new recorded run and a review of that criterion.

A case is disruptive when it needs one of these, and the catalog records which one:

- `user-manager-termination` — `SC-03-02`. Restarting the user manager kills every other service
  in the session.
- `login-termination` — `SC-03-03`, `SC-03-04`. Ending the last login session disconnects other
  users of the account.
- `reboot` — `SC-03-05`. The machine is shared.
- `privilege` — `SC-07-01` to `SC-07-03`, `SC-13-01`, `SC-13-03`. Package upgrades, masking
  systemd, and removing a control group controller change the system configuration.
- `hostile-resource` — `SC-05-01`, `SC-14-01` to `SC-14-11`, `LM-01`, `LM-02`, `LM-03`. Process
  identifier pressure, memory exhaustion, processor saturation, and a deliberately hostile fixture
  all affect other users of the machine.

That leaves 546 of the 570 enumerated cases nominally runnable at user service scope. "Nominally"
matters: most of them still need an installed Core service and an implemented handler, so on USTC
they are only ever a check that the harness itself behaves, never an experiment result.

## Running

```sh
RUNNER=scripts/experiments/linux-core-service-ownership/run.sh

# List the selection without touching anything.
bash "$RUNNER" --list

# Real run in a disposable environment, user scope, against an installed unit.
bash "$RUNNER" --mode full --disposable --service-mode user \
  --core-unit dolly-core@inst1.service --seed 1
```

Invoke it through `bash` as shown, or `chmod +x` it first. Case handlers are also invoked through
`bash`, so a handler committed without the executable bit still runs rather than being silently
skipped.

The historical `--mode smoke` criterion expects every selected case to be `inconclusive`. It has
not been revalidated since handler coverage reached 570 of 570 catalog entries, so it is not
currently a claimed passing self-check.

Useful options:

- `--group ID`, `--arm ID`, `--id-prefix PREFIX` narrow the selection; the manifest records the
  filters, so a narrowed run can never be mistaken for a complete matrix.
- `--dry-run` walks the case list without running handlers.
- `--output-dir DIR` moves the artifacts; the default is
  `artifacts/experiments/linux-core-service-ownership/<run id>`.
- `--allow-preexisting` records a non-empty `dolly-test-` namespace as the baseline instead of
  refusing to start. Prefer cleaning up by hand. Since residue is now judged per run (see
  "Residue is scoped to one run" below), this refusal triggers only on items already carrying
  *this* run's own prefix.

Exit codes: `0` success, `1` failure, `2` usage error, `3` environment requirement unmet, `4` the
run is incomplete because inconclusive cases remain.

## The disposable container

Disruptive cases must not run on a shared host. `run-disposable-container.sh` builds a container
with its own systemd instance, user lingering enabled, and control group version 2 delegated to an
unprivileged account, then destroys it afterwards. In experiment mode, it invokes the experiment
runner with `--disposable`; options it does not own are passed through unchanged, so `--group`,
`--id-prefix`, and the other experiment filters behave the same inside and outside. The wrapper
owns `--output-dir` and `--disposable`; attempts to supply either are rejected rather than
overriding its artifact mount or isolation declaration.

```bash
CONTAINER=scripts/experiments/linux-core-service-ownership/run-disposable-container.sh

# Docker Hub is unreachable from some networks; point --base at a mirror then.
bash "$CONTAINER" --base docker.m.daocloud.io/library/ubuntu:24.04 --group dependency-unavailable

# Run exact Linux integration test files instead of the ownership experiment.
# --test-file is repeatable.
bash "$CONTAINER" --base docker.m.daocloud.io/library/ubuntu:24.04 \
  --test-file tests/conformance/security/linux-module-launcher-integration.test.ts \
  --test-file tests/conformance/security/linux-module-cgroup-integration.test.ts
```

`--test-file` switches the wrapper from the ownership experiment to the exact Linux integration
test runner. It may be repeated, but it cannot be combined with options passed to the ownership
experiment, including its selection filters. Wrapper options such as `--base` and `--keep` remain
available in either mode.

Both modes record `source-commit.txt`, `source-status.txt`, `source-snapshot.txt`, `command.txt`,
`preflight.txt`, and `environment.txt` in the invocation's artifact directory. The wrapper archives
the exact `HEAD` commit to a unique temporary snapshot; dirty, ignored, and untracked checkout files
are therefore never test inputs, and it never mounts the checkout itself, `.git`, or owner files
such as `.env`. That snapshot and the installed dependencies are mounted read-only.
The container uses a new non-root account with no supplementary groups. Before running any test or
hostile fixture, the wrapper proves that the source and dependencies are readable but not writable,
the private checkout files are absent, and only `node_modules/.vite-temp` plus the invocation's
artifact directory are writable. A controlled `node_modules` link inside the snapshot points to
that ephemeral dependency view so Node resolution follows no host checkout path. The temporary
snapshot is removed by its exact recorded path only after the exact container is removed; `--keep`
and a lost terminal retain both. Required Linux integration mode turns any unavailable prerequisite
into a collection failure, so an all-skipped file cannot be reported as a passing run.

**Use `--base` when the default base image cannot be resolved.** On a network where
`registry-1.docker.io` does not resolve, the run fails during the image build with
`failed to resolve source metadata for docker.io/library/ubuntu:24.04`, before any case runs.
`docker.m.daocloud.io/library/ubuntu:24.04` is a working mirror. Three people hit the unmirrored
default separately before this was written down; check `docker images` for an already-pulled mirror
tag before assuming the network is at fault.

The full matrix outlives a typical remote shell, so detach it and read the log rather than holding
the connection open. A hangup no longer destroys a running container, but the output still goes
wherever the terminal pointed:

```bash
nohup setsid bash "$CONTAINER" --base docker.m.daocloud.io/library/ubuntu:24.04 \
  > run.log 2>&1 < /dev/null &
```

Two environment facts worth knowing before reading a container result. The runner executes as an
unprivileged account, so `/proc/sys/kernel/ns_last_pid` is not writable and `loginctl` cannot change
lingering. And `docker exec` does not create a login session, so a user has zero sessions; a case
that needs one reports `inconclusive` rather than passing vacuously.

### Never remove containers by name prefix

Each invocation creates its own container name and its own artifact directory, so several runs can
proceed at once. Remove **only the exact container name your own run reported**:

```bash
docker rm -f dolly-experiment-1126268-4f2a9c31          # correct: one exact name

docker rm -f $(docker ps -aq --filter name=dolly-experiment-)   # destroys other people's runs
docker rm -f dolly-experiment-*                                 # same
```

Two 210-case full runs have already been destroyed this way, at case 72 and case 183. **The victim
sees no error at all**: the container disappears, the run stops mid-matrix, and the log simply ends.
That is the hardest possible failure to attribute, and it costs roughly eleven minutes of run time
plus the time spent looking for a defect that was never there.

This is the same problem as scoped residue, from the other side: concurrent runs must neither
misjudge each other's leftovers nor delete each other.

## Cases that must run on their own

The catalog marks some cases `exclusive`. `SC-03-02-user-manager-restart` is currently the only
one: ending the systemd user manager is its event under test, and an unprivileged account cannot
start `user@<uid>.service` again, so every later case in the same run fails to reach the bus and
reports a cause unrelated to what it tested.

The runner refuses to start when the selection contains an `exclusive` case together with any
other case, and exits `2`. It does not reorder the selection or quietly run the case by itself: an
automatic correction would leave an invalid invocation in use and the run it produced would look
ordinary.

Use `--exclude-id` to run the rest of the group in one invocation:

```bash
bash "$RUNNER" --id-prefix SC-03-02-user-manager-restart --disposable
bash "$RUNNER" --group lifecycle --exclude-id SC-03-02-user-manager-restart --disposable
```

Prefer this over a loop of single `--id-prefix` invocations. A loop that omits a case produces
*nothing at all* for it: no output, no failure, no signal. A case someone forgot and a case that
never existed look identical. One invocation with an exclusion has a case count that can be checked
against the catalog instead.

`--exclude-id` is repeatable, and an identifier that matches no case is rejected with exit `2`
rather than silently changing nothing.

**An excluded run is never a complete run**, and the artifacts say so. `manifest.json` and
`summary.json` both carry a `selection` block:

```json
"selection": {
  "catalogCaseCount": 570,
  "selectedCaseCount": 3,
  "complete": false,
  "excludedIds": ["SC-03-02-user-manager-restart"],
  "narrowedBy": ["group", "exclude-id", "non-disruptive-only"]
}
```

and the printed report gains a line directly above the counts whenever `complete` is false:

```text
selection             narrowed: 3 of 570 case(s) (by group, exclude-id, non-disruptive-only); excluded SC-03-02-user-manager-restart
passed                3
```

Check `complete` before quoting a result as a group or matrix pass. Any action that narrows
coverage — group, arm, prefix, exclusion, or `--non-disruptive-only` — appears there.

## Residue is scoped to one run

The reserved `dolly-test-` namespace is shared by every run on the machine, and a run inside a
privileged container is visible in the host's process list. Without scoping, a concurrent run
appears in an unrelated run's "after" inventory and is reported as that run's residue: a false
INV-12 violation that also blocks the next run through the pre-existing-namespace check.

Ownership is decided by the run's own unique prefix. Each run therefore writes both readings:

| File | Contents |
| --- | --- |
| `inventory-before.txt`, `inventory-after.txt` | items carrying this run's prefix; the residue verdict uses only these |
| `inventory-foreign-before.txt`, `inventory-foreign-after.txt` | items in the reserved namespace belonging to another run, excluded from the verdict |
| `inventory-stale-candidates.txt` | foreign items present **both before and after** this run |
| `inventory-before-all.txt`, `inventory-after-all.txt` | the unscoped readings |

`summary.json` carries the same counts under `cleanup.residueScope`, including
`excludedAppearedDuringRun` and `excludedPresentThroughout`. The excluded items are written out
rather than dropped: a scoping rule that is too wide would turn a false residue report into a
silently missed one, and a silently missed one produces no signal at all.

### Check the stale-candidate set periodically

One property was deliberately traded away, and is recorded here rather than left to be discovered:
the old check refused to start whenever *anything* sat in the reserved namespace, which also caught
stale leftovers from earlier runs. That is now a warning and a file instead of a refusal, because it
could not distinguish a stale leftover from a healthy concurrent run.

`inventory-stale-candidates.txt` is what replaces it, and it is the reason the two foreign readings
are distinguished rather than merged:

- an item that **appeared during** the run is a concurrent run, and is expected;
- an item present **before and after** is a candidate stale leftover, because no run of this harness
  should outlive its own invocation.

Nothing refuses to start on that set, so it surfaces only when somebody reads it. Check it when a
run reports a non-zero `excludedPresentThroughout`, and sweep the machine periodically; leftovers
otherwise accumulate silently until they exhaust something. A warning nobody reads is not a warning.

## Artifacts

Everything lands in one run directory:

- `manifest.json` — source revision, dirty-worktree flag, kernel and systemd versions, effective
  service configuration and its digest, seed and derived seeds, ordered case list, filters, and
  the twelve invariants.
- `ordered-cases.tsv` — the exact list the runner iterates. The runner reads only this file, so
  the manifest and the executed cases cannot drift apart.
- `environment.env` — the raw environment facts the manifest was built from.
- `core-unit-show.txt` — `systemctl show` output for the Core unit, when one was supplied.
- `inventory-before.txt`, `inventory-after.txt` — the reserved `dolly-test-` namespace before the
  run and after cleanup.
- `created-units.txt`, `created-cgroups.txt` — the ledgers cleanup is allowed to act on.
- `cases/<case id>/` — per-case artifacts written by that case's handler.
- `results.jsonl` — one result line per case.
- `cleanup.json` — what cleanup attempted, what failed, and any note.
- `summary.json` — the machine-readable summary, including failed and inconclusive cases.
- `run.log` — timestamped runner events.

The manifest and summary keep no secret, private endpoint, or private media URL. The host and user
names are replaced with stable redacted labels (`host-<digest>`, `user-<digest>`), so two runs on
the same machine are comparable without naming it.

The runner writes a `.gitignore` containing `*` into the output directory the first time it uses
it, so run artifacts are never committed by accident. It does not change the repository's own
ignore file.

## Reading a result

`summary.json` carries the verdict and the reason for it.

- `pass` — every case that must satisfy the strict invariants passed **and** retained every
  artifact it declared, cleanup succeeded, and no residue remains.
- `fail` — at least one such case failed, or cleanup left residue. Under the protocol's stopping
  rule the first failure stops architectural promotion but not diagnosis: revise the implementation
  or the ADR, record a new protocol version, and rerun the complete matrix. Do not delete the case.
- `incomplete` — no failure, but inconclusive cases remain.
- `harness-ok` / `harness-fail` — only from `--mode smoke`. A smoke run sets
  `harnessSelfCheck: true` and `experimentResult: "none"`, so it can never be quoted as evidence
  about the hypotheses.

Three classification rules are enforced in `summarize.mjs`, not trusted from handlers:

1. a case that declared an artifact it did not retain becomes `inconclusive`, never `passed`;
2. a case in the ordered list that produced no result line at all becomes `inconclusive`; and
3. a case whose handler reported an unrecognised status becomes `inconclusive`.

Baseline arms are reported separately. The two baselines exist to be compared against, and one of
them is expected to fail cleanup invariants; a baseline failure appears under
`baselineObservations` and does not turn the verdict into `fail`.

## Cleanup and proving zero residue

The runner cleans up on its own and then proves it:

1. every unit it creates is recorded in `created-units.txt` before it is started, and every control
   group it creates is recorded in `created-cgroups.txt`;
2. cleanup stops only names that match `dolly-test-*.service` **and** carry this run's own prefix,
   re-validating each name rather than trusting the ledger;
3. a control group is removed only when it sits under `/sys/fs/cgroup`, carries this run's prefix,
   and its `cgroup.events` reports `populated 0`. Removal uses `rmdir`, which cannot delete a
   non-empty tree;
4. the run's state directory is removed only when it is inside the run's own output directory; and
5. `inventory-after.txt` is compared with `inventory-before.txt`. Anything added and not removed is
   reported as residue and fails the run under invariant INV-12.

The harness never removes a path, service, process, or control group discovered from case output.

Manual verification after a run, if you want to check independently:

```sh
systemctl --user list-units --all 'dolly-test-*'
find /sys/fs/cgroup -maxdepth 8 -type d -name 'dolly-test-*' -o -name 'dolly-module-*'
pgrep -a -f 'dolly-test-'
```

All three should print nothing. If a control group is still populated, cleanup deliberately leaves
it in place for inspection and marks the run failed; kill it with `cgroup.kill` after you have
recorded what is inside it.

## Adding a case handler

The runner looks for `handlers/<handler>.sh`, where `<handler>` is the handler name in the catalog.
One handler serves a whole case family; the case identity arrives through the environment:

- `DOLLY_EXPERIMENT_CASE_ID`, `_CASE_GROUP`, `_CASE_ARM` — which case to run.
- `DOLLY_EXPERIMENT_CASE_DIR` — where this case's artifacts must be written.
- `DOLLY_EXPERIMENT_RUN_DIR`, `_STATE_DIR`, `_MANIFEST` — run directory, scratch state, manifest.
- `DOLLY_EXPERIMENT_UNIT_PREFIX` — the prefix every unit and control group name must start with.
- `DOLLY_EXPERIMENT_UNIT_LEDGER`, `_CGROUP_LEDGER` — ledgers to append to before creating
  anything.
- `DOLLY_EXPERIMENT_SYSTEMCTL_SCOPE` — `--user` or `--system`.
- `DOLLY_EXPERIMENT_SEED`, `_REPOSITORY` — run seed and repository root.

A handler must write these files into its case directory, named exactly as the catalog's
`requiredArtifacts` entries: `events`, `barrier-snapshots` (interruption cases only),
`process-and-cgroup-observations`, and `case-outcome`. `case-outcome` holds `key=value` lines and
must contain `status=passed|failed|inconclusive|not-applicable` and a `reason`. Handlers should
source `lib/safety.sh` and register every unit and control group through
`dolly_ledger_add_unit` and `dolly_ledger_add_cgroup`, which refuse names outside the run prefix.

Everything a handler reports is re-checked by the runner and the summary; a handler cannot mark
itself passing without artifacts, and unexpected text in a status or reason is replaced rather than
copied into the summary.

## Known gaps before the full matrix can run

These block a complete run and are not defects in the runner:

1. All 570 catalog entries resolve to handler files, but no complete catalog version 5 result has
   been established merely by that file check. Full evidence still requires the prescribed
   service scopes, clean environments, retained artifacts, and per-case results.
2. There is no installable Core service unit yet, so no case can exercise the real restart path.
   Until one exists, `manifest.json` records `serviceConfiguration.available: false` and the
   configuration digest is null.
3. `runtime-bootstrap.ts` still rejects every configured Module, and ADR 0009 is still Proposed.
   The experiment cannot be run against a Module path that is disabled by design.
4. Group termination (`cgroup.kill` plus `cgroup.events` reporting `populated 0`) and the startup
   stop proof are not wired into the Core startup recovery path yet, so the invariants about
   proving an old control group empty cannot be evaluated.
5. Protocol version 3 does not fix which signal terminates Core at an interruption point. The
   catalog uses `SIGKILL`, the strictest case and the one Hypothesis 2 names, and records the
   choice in the manifest. If the protocol later requires `SIGTERM` with a finite stop timeout as
   well, the matrix doubles.
6. Protocol version 3 has no case for termination while Core stays alive, although ADR 0009
   required failure test 3 demands it. The catalog covers it as the `live-core-termination` group,
   sourced from the ADR alone. A future protocol version should adopt those cases explicitly.
