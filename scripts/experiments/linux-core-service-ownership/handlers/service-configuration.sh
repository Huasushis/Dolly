#!/bin/bash
# Case handler: effective Core service configuration.
#
# Architecture Decision Record 0009 lists the effective unit settings a Core
# service must have and the weakenings it must refuse. Each case here builds one
# real transient user service that differs from the required configuration in
# exactly one setting, runs the real verifier from
# `src/core/linux-core-service-binding.ts` inside it, and requires the exact
# refusal the protocol expects.
#
# Every case runs two services, not one:
#
#   * a control service configured the way ADR 0009 requires, and
#   * a weakened service that differs from the control in one setting.
#
# The assertion is on the difference between the two refusal sets, not on the
# weakened set alone. A host contributes refusals of its own - this machine has
# user lingering disabled, and `systemd-run` cannot set the `:` prefix on
# `ExecStart` - and an assertion on the weakened set alone would either have to
# encode those host facts or degrade into "something failed". The difference
# isolates the single setting under test, and the control is itself checked:
# its refusals must be a subset of the declared host limitations, so a control
# that is not conformant makes the case inconclusive rather than passing.
#
# Each case additionally asserts the exact effective value the service manager
# reported for the setting it changed, so a case cannot pass because a property
# was silently ignored by an older systemd.
#
# Cases: SC-02-01 through SC-02-16.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"
STATE_DIR="${DOLLY_EXPERIMENT_STATE_DIR:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

PROBE="${REPOSITORY}/tests/conformance/core/fixtures/core-service-binding-probe.ts"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

# How long one service may take to produce its single result line.
PROBE_DEADLINE_DECISECONDS=900

: >"${EVENTS}"
: >"${OBSERVATIONS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

observe() {
  printf '%s=%s\n' "$1" "$2" >>"${OBSERVATIONS}"
}

# Writes the outcome and exits. Every exit path goes through here so the case
# always has a readable status rather than defaulting to unreadable.
finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\n' "${status}" "${reason}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  exit 0
}

# Refusals this host produces regardless of the setting under test. They are
# facts about the environment, so a control service may report them:
#
#   * CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED - `systemd-run` offers no way
#     to set the systemd `:` prefix on a transient unit, so no service this
#     handler creates carries the `no-env-expand` flag. The `executable-paths`
#     handler covers the prefix directly by creating its transient units through
#     the service manager's own interface.
#   * CORE_SERVICE_USER_LINGERING_DISABLED / _UNKNOWN - lingering is a property
#     of the account, and enabling it is a durable change this experiment is not
#     allowed to make on the authorized server.
#
# Anything else in a control service means the control was not conformant, and
# the case reports inconclusive rather than reading a difference off a broken
# baseline.
ENVIRONMENT_LIMITATION_CODES="CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED
CORE_SERVICE_USER_LINGERING_DISABLED
CORE_SERVICE_USER_LINGERING_UNKNOWN"

# The configuration ADR 0009 requires, as transient unit properties. Every case
# starts from this list and changes exactly one setting.
CONTROL_PROPERTIES=(
  -p Type=exec
  -p Restart=on-failure
  -p StartLimitBurst=5
  -p StartLimitIntervalSec=30s
  -p KillMode=control-group
  -p SendSIGKILL=yes
  -p TimeoutStopSec=30s
  -p Delegate=yes
  -p DelegateSubgroup=core
  -p ExitType=main
  -p RestartMode=normal
  -p RemainAfterExit=no
)

[ -f "${PROBE}" ] || finish inconclusive binding-probe-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing

NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || finish inconclusive node-not-installed
# The service manager needs an absolute executable, and the assertions compare
# the reported `ExecStart` path, so the resolved path is used everywhere.
case "${NODE_BIN}" in /*) ;; *) finish inconclusive node-path-not-absolute ;; esac

stop_unit() {
  systemctl --user stop "$1" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1" >/dev/null 2>&1 || true
}

# Prints the control properties with the named settings removed, one array
# element per line, so a caller can rebuild the list with one setting replaced.
properties_excluding() {
  local -a drop=("$@")
  local index=0 flag value key candidate skip
  while [ "${index}" -lt "${#CONTROL_PROPERTIES[@]}" ]; do
    flag="${CONTROL_PROPERTIES[${index}]}"
    value="${CONTROL_PROPERTIES[$((index + 1))]}"
    key="${value%%=*}"
    skip="no"
    for candidate in ${drop[@]+"${drop[@]}"}; do
      [ "${candidate}" = "${key}" ] && skip="yes"
    done
    if [ "${skip}" = "no" ]; then
      printf '%s\n%s\n' "${flag}" "${value}"
    fi
    index=$((index + 2))
  done
}

# Starts one transient service that runs the probe as its main process and waits
# for the probe's single result line. The service is not started with `--wait`
# because two of the settings under test - `RemainAfterExit=yes` and
# `ExitType=cgroup` - deliberately keep the unit active after the probe exits.
#
# Sets RUN_UNIT and returns non-zero when no result line appeared.
run_probe_unit() {
  local suffix="$1" out="$2"
  shift 2
  local unit="${UNIT_PREFIX}${suffix}"
  RUN_UNIT="${unit}.service"
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${RUN_UNIT}" || return 3
  : >"${out}"
  event "starting ${RUN_UNIT}"
  if ! systemd-run --user --quiet "--unit=${unit}" \
      -p "StandardOutput=file:${out}" \
      -p "StandardError=file:${out}.stderr" \
      "$@" \
      -- "${NODE_BIN}" --import "file://${TSX_LOADER}" "${PROBE}" "${RUN_UNIT}" user \
      >>"${CASE_DIR}/systemd-run.stderr" 2>&1; then
    event "service manager refused to start ${RUN_UNIT}"
    return 4
  fi
  local waited=0
  while [ "${waited}" -lt "${PROBE_DEADLINE_DECISECONDS}" ]; do
    [ -s "${out}" ] && break
    sleep 0.1
    waited=$((waited + 1))
  done
  event "${RUN_UNIT} active-state=$(systemctl --user show "${RUN_UNIT}" -p ActiveState --value 2>/dev/null) result=$(systemctl --user show "${RUN_UNIT}" -p Result --value 2>/dev/null)"
  stop_unit "${RUN_UNIT}"
  event "stopped ${RUN_UNIT}"
  [ -s "${out}" ] || return 5
  return 0
}

# The refusal codes the real verifier produced, sorted, one per line. An
# observation that could not be collected at all reports its own failure codes,
# which is still a refusal and still exact.
probe_codes() {
  node -e '
    const fs = require("node:fs");
    const line = fs.readFileSync(process.argv[1], "utf8").split("\n").reverse()
      .find((candidate) => candidate.trim().startsWith("{"));
    if (!line) { console.error("no-result-line"); process.exit(2); }
    const out = JSON.parse(line);
    const codes = out.observed === false
      ? (out.failures ?? []).map((failure) => failure.code)
      : (out.result?.verified ? [] : (out.result?.failures ?? []).map((failure) => failure.code));
    for (const code of [...new Set(codes)].sort()) console.log(code);
  ' "$1"
}

# One value out of the probe result, as compact JSON, so an assertion compares
# the exact reported value rather than a rendering of it.
probe_field() {
  local file="$1"
  shift
  node -e '
    const fs = require("node:fs");
    const [file, ...path] = process.argv.slice(1);
    const line = fs.readFileSync(file, "utf8").split("\n").reverse()
      .find((candidate) => candidate.trim().startsWith("{"));
    if (!line) { console.error("no-result-line"); process.exit(2); }
    let value = JSON.parse(line);
    for (const key of path) value = value === null || value === undefined ? undefined : value[key];
    console.log(JSON.stringify(value === undefined ? null : value));
  ' "${file}" "$@"
}

# Elements of the first newline-separated set that are absent from the second.
set_difference() {
  comm -23 <(printf '%s\n' "$1" | grep -v '^$' | LC_ALL=C sort -u) \
           <(printf '%s\n' "$2" | grep -v '^$' | LC_ALL=C sort -u)
}

join_set() {
  printf '%s\n' "$1" | grep -v '^$' | LC_ALL=C sort -u | paste -sd, -
}

# ---------------------------------------------------------------------------
# The setting each case weakens, the refusals that weakening must add, and the
# exact effective value the service manager must report for it.
# ---------------------------------------------------------------------------

WEAKENED_DROP=()
WEAKENED_ADD=()
EXPECTED_ADDED=()
FIELD_PATH=()
FIELD_EXPECTED=""
ENVIRONMENT_FILE="${STATE_DIR}/${CASE_ID}.env"

case "${CASE_ID}" in
  SC-02-01-restart-policy-absent)
    WEAKENED_DROP=(Restart)
    WEAKENED_ADD=(-p Restart=no)
    EXPECTED_ADDED=(CORE_SERVICE_RESTART_POLICY_INVALID)
    FIELD_PATH=(observation unit restart)
    FIELD_EXPECTED='"no"'
    ;;

  SC-02-02-restart-limit-infinite)
    # systemd disables its own restart rate limit when the burst is zero, which
    # is the "not finite" the ADR forbids; the interval stays finite so the
    # difference is one setting.
    WEAKENED_DROP=(StartLimitBurst)
    WEAKENED_ADD=(-p StartLimitBurst=0)
    EXPECTED_ADDED=(CORE_SERVICE_RESTART_LIMIT_INVALID)
    FIELD_PATH=(observation unit startLimitBurst)
    FIELD_EXPECTED='0'
    ;;

  SC-02-03-kill-mode-not-control-group)
    WEAKENED_DROP=(KillMode)
    WEAKENED_ADD=(-p KillMode=process)
    EXPECTED_ADDED=(CORE_SERVICE_KILL_MODE_INVALID)
    FIELD_PATH=(observation unit killMode)
    FIELD_EXPECTED='"process"'
    ;;

  SC-02-04-send-sigkill-disabled)
    WEAKENED_DROP=(SendSIGKILL)
    WEAKENED_ADD=(-p SendSIGKILL=no)
    EXPECTED_ADDED=(CORE_SERVICE_SIGKILL_DISABLED)
    FIELD_PATH=(observation unit sendSigkill)
    FIELD_EXPECTED='false'
    ;;

  SC-02-05-timeout-stop-infinite)
    # systemd reports an infinite duration as the largest unsigned 64-bit value,
    # which the verifier reads as `Number.POSITIVE_INFINITY` and JSON renders as
    # null, so the exact expected value here is null.
    WEAKENED_DROP=(TimeoutStopSec)
    WEAKENED_ADD=(-p TimeoutStopSec=infinity)
    EXPECTED_ADDED=(CORE_SERVICE_STOP_TIMEOUT_INVALID)
    FIELD_PATH=(observation unit timeoutStopUSec)
    FIELD_EXPECTED='null'
    ;;

  SC-02-06-delegate-disabled)
    # `DelegateSubgroup` has no meaning without delegation, so it is dropped
    # rather than left set to a value the manager would ignore. Three refusals
    # follow from the one setting: delegation is off, no subgroup is delegated,
    # and systemd enables the delegated controllers on a service root only when
    # that service asked for delegation, so `cpu` is no longer available there.
    WEAKENED_DROP=(Delegate DelegateSubgroup)
    WEAKENED_ADD=(-p Delegate=no)
    EXPECTED_ADDED=(
      CORE_SERVICE_CONTROLLER_UNAVAILABLE
      CORE_SERVICE_DELEGATE_SUBGROUP_INVALID
      CORE_SERVICE_DELEGATION_DISABLED
    )
    FIELD_PATH=(observation unit delegate)
    FIELD_EXPECTED='false'
    ;;

  SC-02-07-delegate-subgroup-absent)
    WEAKENED_DROP=(DelegateSubgroup)
    WEAKENED_ADD=()
    EXPECTED_ADDED=(CORE_SERVICE_DELEGATE_SUBGROUP_INVALID)
    FIELD_PATH=(observation unit delegateSubgroup)
    FIELD_EXPECTED='""'
    ;;

  SC-02-08-cgroup-v1)
    # Which control group hierarchy the service manager provides is decided at
    # boot for the whole machine by the kernel command line, and the runner
    # refuses to start at all unless /sys/fs/cgroup is control group version 2.
    # There is therefore no configuration of a user service that can produce
    # this case, and nothing this profile is allowed to do can produce it
    # either: it needs privilege and a reboot.
    event "recording the host control group hierarchy rather than changing it"
    observe host-cgroup-filesystem "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"
    observe host-cgroup-controllers "$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
    observe case-requires "a service manager on a control group version 1 hierarchy"
    observe case-blocked-by "run.sh exits with the environment code unless /sys/fs/cgroup is cgroup2fs"
    finish not-applicable requires-cgroup-v1-boot-that-this-profile-cannot-produce
    ;;

  SC-02-09-controller-missing)
    # Delegating only two of the three required controllers is the smallest
    # faithful form of "a required controller is not delegated": it changes what
    # the delegated service root actually offers, not merely what the unit asked
    # for.
    WEAKENED_DROP=(Delegate)
    WEAKENED_ADD=(-p "Delegate=memory pids")
    EXPECTED_ADDED=(CORE_SERVICE_CONTROLLER_UNAVAILABLE)
    FIELD_PATH=(observation delegatedRootControllers)
    FIELD_EXPECTED='["memory","pids"]'
    ;;

  SC-02-10-exit-type-cgroup)
    WEAKENED_DROP=(ExitType)
    WEAKENED_ADD=(-p ExitType=cgroup)
    EXPECTED_ADDED=(CORE_SERVICE_EXIT_TYPE_INVALID)
    FIELD_PATH=(observation unit exitType)
    FIELD_EXPECTED='"cgroup"'
    ;;

  SC-02-11-restart-mode-direct)
    WEAKENED_DROP=(RestartMode)
    WEAKENED_ADD=(-p RestartMode=direct)
    EXPECTED_ADDED=(CORE_SERVICE_RESTART_MODE_INVALID)
    FIELD_PATH=(observation unit restartMode)
    FIELD_EXPECTED='"direct"'
    ;;

  SC-02-12-remain-after-exit)
    WEAKENED_DROP=(RemainAfterExit)
    WEAKENED_ADD=(-p RemainAfterExit=yes)
    EXPECTED_ADDED=(CORE_SERVICE_REMAIN_AFTER_EXIT_ENABLED)
    FIELD_PATH=(observation unit remainAfterExit)
    FIELD_EXPECTED='true'
    ;;

  SC-02-13-success-exit-status-override)
    WEAKENED_DROP=()
    WEAKENED_ADD=(-p SuccessExitStatus=42)
    EXPECTED_ADDED=(CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN)
    FIELD_PATH=(observation unit successExitStatus)
    FIELD_EXPECTED='{"exitCodes":[42],"signals":[]}'
    ;;

  SC-02-14-restart-prevent-exit-status-override)
    WEAKENED_DROP=()
    WEAKENED_ADD=(-p RestartPreventExitStatus=42)
    EXPECTED_ADDED=(CORE_SERVICE_RESTART_PREVENT_EXIT_STATUS_OVERRIDDEN)
    FIELD_PATH=(observation unit restartPreventExitStatus)
    FIELD_EXPECTED='{"exitCodes":[42],"signals":[]}'
    ;;

  SC-02-15-pass-environment-set)
    WEAKENED_DROP=()
    WEAKENED_ADD=(-p PassEnvironment=DOLLY_TEST_INHERITED_SENTINEL)
    EXPECTED_ADDED=(CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL)
    FIELD_PATH=(observation unit passEnvironment)
    FIELD_EXPECTED='["DOLLY_TEST_INHERITED_SENTINEL"]'
    ;;

  SC-02-16-environment-file-set)
    # The file lives in the run's own scratch directory, which the runner
    # removes, so the case leaves nothing behind outside its run directory.
    printf 'DOLLY_TEST_INHERITED_SENTINEL=from-environment-file\n' >"${ENVIRONMENT_FILE}" \
      || finish inconclusive could-not-write-environment-file
    WEAKENED_DROP=()
    WEAKENED_ADD=(-p "EnvironmentFile=${ENVIRONMENT_FILE}")
    EXPECTED_ADDED=(CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL)
    FIELD_PATH=(observation unit environmentFiles)
    FIELD_EXPECTED="[\"${ENVIRONMENT_FILE}\"]"
    ;;

  *)
    finish inconclusive unknown-case
    ;;
esac

# ---------------------------------------------------------------------------
# The control service: the configuration ADR 0009 requires.
# ---------------------------------------------------------------------------

# Unit names carry the case identity as well as the run prefix, so two cases in
# one run can never collide over a name that is still deactivating.
UNIT_SUFFIX="$(printf '%s' "${CASE_ID}" | tr 'A-Z' 'a-z')"

CONTROL_OUTPUT="${CASE_DIR}/control-observation.json"
run_probe_unit "${UNIT_SUFFIX}-control" "${CONTROL_OUTPUT}" "${CONTROL_PROPERTIES[@]}"
case "$?" in
  0) ;;
  3) finish inconclusive control-unit-name-refused-by-ledger ;;
  4) finish inconclusive control-unit-would-not-start ;;
  *) finish inconclusive control-unit-produced-no-result ;;
esac

CONTROL_UNIT="${RUN_UNIT}"
CONTROL_CODES="$(probe_codes "${CONTROL_OUTPUT}")" || finish inconclusive control-result-unreadable

observe control-unit "${CONTROL_UNIT}"
observe control-main-pid "$(probe_field "${CONTROL_OUTPUT}" observation unit mainPid)"
observe control-self-pid "$(probe_field "${CONTROL_OUTPUT}" observation selfPid)"
observe control-control-group "$(probe_field "${CONTROL_OUTPUT}" observation unit controlGroup)"
observe control-self-cgroup "$(probe_field "${CONTROL_OUTPUT}" observation selfCgroupPath)"
observe control-type "$(probe_field "${CONTROL_OUTPUT}" observation unit type)"
observe control-delegate-subgroup "$(probe_field "${CONTROL_OUTPUT}" observation unit delegateSubgroup)"
observe control-delegated-root-controllers "$(probe_field "${CONTROL_OUTPUT}" observation delegatedRootControllers)"
observe control-exec-start "$(probe_field "${CONTROL_OUTPUT}" observation unit execStart)"
observe control-refusal-codes "$(join_set "${CONTROL_CODES}")"

# A control service that refuses for any reason other than a declared host
# limitation is not the baseline this case needs.
CONTROL_UNEXPECTED="$(set_difference "${CONTROL_CODES}" "${ENVIRONMENT_LIMITATION_CODES}")"
observe control-unexpected-codes "$(join_set "${CONTROL_UNEXPECTED}")"
if [ -n "${CONTROL_UNEXPECTED}" ]; then
  event "control service refused for reasons beyond the declared host limitations"
  finish inconclusive control-service-not-conformant
fi

# ---------------------------------------------------------------------------
# The weakened service: one setting changed.
# ---------------------------------------------------------------------------

mapfile -t WEAKENED_PROPERTIES < <(properties_excluding ${WEAKENED_DROP[@]+"${WEAKENED_DROP[@]}"})
WEAKENED_PROPERTIES+=(${WEAKENED_ADD[@]+"${WEAKENED_ADD[@]}"})

WEAKENED_OUTPUT="${CASE_DIR}/weakened-observation.json"
run_probe_unit "${UNIT_SUFFIX}-weakened" "${WEAKENED_OUTPUT}" "${WEAKENED_PROPERTIES[@]}"
case "$?" in
  0) ;;
  3) finish inconclusive weakened-unit-name-refused-by-ledger ;;
  4) finish inconclusive weakened-unit-would-not-start ;;
  *) finish inconclusive weakened-unit-produced-no-result ;;
esac

WEAKENED_UNIT="${RUN_UNIT}"
WEAKENED_CODES="$(probe_codes "${WEAKENED_OUTPUT}")" || finish inconclusive weakened-result-unreadable

observe weakened-unit "${WEAKENED_UNIT}"
observe weakened-properties "$(printf '%s ' ${WEAKENED_ADD[@]+"${WEAKENED_ADD[@]}"})"
observe weakened-main-pid "$(probe_field "${WEAKENED_OUTPUT}" observation unit mainPid)"
observe weakened-self-pid "$(probe_field "${WEAKENED_OUTPUT}" observation selfPid)"
observe weakened-control-group "$(probe_field "${WEAKENED_OUTPUT}" observation unit controlGroup)"
observe weakened-self-cgroup "$(probe_field "${WEAKENED_OUTPUT}" observation selfCgroupPath)"
observe weakened-delegated-root-controllers "$(probe_field "${WEAKENED_OUTPUT}" observation delegatedRootControllers)"
observe weakened-refusal-codes "$(join_set "${WEAKENED_CODES}")"

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

# The manager must really have applied the setting. Without this a case would
# pass on a systemd that silently ignored the property.
FIELD_OBSERVED="$(probe_field "${WEAKENED_OUTPUT}" "${FIELD_PATH[@]}")" \
  || finish inconclusive weakened-field-unreadable
observe asserted-field "$(printf '%s.' "${FIELD_PATH[@]}" | sed 's/\.$//')"
observe asserted-field-expected "${FIELD_EXPECTED}"
observe asserted-field-observed "${FIELD_OBSERVED}"
if [ "${FIELD_OBSERVED}" != "${FIELD_EXPECTED}" ]; then
  event "the service manager did not report the weakened setting the case configured"
  finish failed weakened-setting-not-in-effect
fi

ADDED="$(set_difference "${WEAKENED_CODES}" "${CONTROL_CODES}")"
REMOVED="$(set_difference "${CONTROL_CODES}" "${WEAKENED_CODES}")"
EXPECTED="$(printf '%s\n' ${EXPECTED_ADDED[@]+"${EXPECTED_ADDED[@]}"})"

observe expected-added-codes "$(join_set "${EXPECTED}")"
observe observed-added-codes "$(join_set "${ADDED}")"
observe observed-removed-codes "$(join_set "${REMOVED}")"

if [ "$(join_set "${ADDED}")" != "$(join_set "${EXPECTED}")" ]; then
  event "the weakened service did not produce exactly the expected additional refusals"
  finish failed unexpected-additional-refusals
fi
if [ -n "${REMOVED}" ]; then
  event "the weakened service dropped a refusal the control service reported"
  finish failed refusal-disappeared-under-weakening
fi

# The reason names the exact codes. The shared `CORE_SERVICE_` prefix is dropped
# so three codes still fit the length the runner accepts in a reason.
finish passed "refused-with-$(join_set "${EXPECTED}" | sed 's/CORE_SERVICE_//g' | tr ',' '.')"
