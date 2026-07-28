#!/bin/bash
# Case handler: Core executable paths that systemd or a shell would interpret.
#
# Architecture Decision Record 0009 requires the Core `ExecStart` to use the
# systemd `:` prefix, so the service manager expands no environment variable in
# the executable path or its arguments, and to name only absolute installed
# paths that carry no text systemd or a shell would interpret. These two cases
# put a real executable behind such a path, start a real service that uses the
# `:` prefix, and require the real verifier from
# `src/core/linux-core-service-binding.ts` to refuse with the exact code while
# the service manager reports the path back byte for byte.
#
# The transient units here are created through the service manager's own
# `StartTransientUnit` interface rather than with `systemd-run`, because
# `systemd-run` builds `ExecStart` from its command line and offers no way to
# set the `:` prefix. The interface takes `ExecStartEx`, whose third member is
# the prefix flag list, so `no-env-expand` can be set explicitly. That flag is
# also the only way to observe the prefix afterwards: the older `ExecStart`
# property does not report it.
#
# Cases:
#   SC-11-01-path-with-spaces               executable path containing spaces
#   SC-11-02-path-with-variable-like-text   executable path containing literal
#                                           ${...} text
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

PROBE_DEADLINE_DECISECONDS=900

: >"${EVENTS}"
: >"${OBSERVATIONS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

observe() {
  printf '%s=%s\n' "$1" "$2" >>"${OBSERVATIONS}"
}

finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\n' "${status}" "${reason}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  exit 0
}

# Refusals that belong to the host rather than to the executable path. Enabling
# user lingering is a durable account change this experiment may not make on the
# authorized server.
ENVIRONMENT_LIMITATION_CODES="CORE_SERVICE_USER_LINGERING_DISABLED
CORE_SERVICE_USER_LINGERING_UNKNOWN"

[ -f "${PROBE}" ] || finish inconclusive binding-probe-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing
command -v busctl >/dev/null 2>&1 || finish inconclusive busctl-not-installed

NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || finish inconclusive node-not-installed
case "${NODE_BIN}" in /*) ;; *) finish inconclusive node-path-not-absolute ;; esac

stop_unit() {
  systemctl --user stop "$1" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1" >/dev/null 2>&1 || true
}

# Writes the program the service manager will run. It replaces itself with the
# probe so the service's main process really is the probe, and it redirects
# before that replacement so the probe's single result line lands in a file
# rather than in the journal.
write_launch_program() {
  local path="$1" unit="$2" out="$3"
  mkdir -p "$(dirname "${path}")" || return 1
  {
    printf '#!/bin/sh\n'
    printf 'exec %s --import %s %s %s user >%s 2>%s\n' \
      "'${NODE_BIN}'" "'file://${TSX_LOADER}'" "'${PROBE}'" "'${unit}'" \
      "'${out}'" "'${out}.stderr'"
  } >"${path}" || return 1
  chmod +x "${path}" || return 1
  return 0
}

# Starts one transient service whose `ExecStart` is the given executable with
# the systemd `:` prefix. Sets RUN_UNIT.
run_probe_unit() {
  local suffix="$1" executable="$2" out="$3"
  local unit="${UNIT_PREFIX}${suffix}"
  RUN_UNIT="${unit}.service"
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${RUN_UNIT}" || return 3
  write_launch_program "${executable}" "${RUN_UNIT}" "${out}" || return 6
  : >"${out}"
  event "starting ${RUN_UNIT} with a no-env-expand ExecStart"
  # The signature is the one StartTransientUnit declares: unit name, job mode,
  # properties, and auxiliary units. ExecStartEx is a(sasas): one command made
  # of an executable path, an argument vector, and a prefix flag list.
  #
  # Every setting ADR 0009 requires is passed explicitly rather than left to a
  # systemd default, so the service is conformant by construction and a future
  # change of default cannot quietly turn the control into a non-conformant
  # baseline.
  if ! busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
      org.freedesktop.systemd1.Manager StartTransientUnit "ssa(sv)a(sa(sv))" \
      "${RUN_UNIT}" fail 15 \
      Description s "Dolly experiment executable path case ${CASE_ID}" \
      Type s exec \
      Restart s on-failure \
      StartLimitBurst u 5 \
      StartLimitIntervalUSec t 30000000 \
      KillMode s control-group \
      SendSIGKILL b true \
      TimeoutStopUSec t 30000000 \
      Delegate b true \
      DelegateSubgroup s core \
      ExitType s main \
      RestartMode s normal \
      RemainAfterExit b false \
      CollectMode s inactive-or-failed \
      ExecStartEx "a(sasas)" 1 "${executable}" 1 "${executable}" 1 no-env-expand \
      0 >>"${CASE_DIR}/start-transient-unit.log" 2>&1; then
    event "the service manager refused to start ${RUN_UNIT}"
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

set_difference() {
  comm -23 <(printf '%s\n' "$1" | grep -v '^$' | LC_ALL=C sort -u) \
           <(printf '%s\n' "$2" | grep -v '^$' | LC_ALL=C sort -u)
}

join_set() {
  printf '%s\n' "$1" | grep -v '^$' | LC_ALL=C sort -u | paste -sd, -
}

# ---------------------------------------------------------------------------
# The path under test.
# ---------------------------------------------------------------------------

# A directory whose name systemd would rewrite if the `:` prefix were missing.
# The single quotes keep the dollar sign and braces literal in this script, so
# the name on disk is exactly the text a unit file would carry.
VARIABLE_LIKE_DIRECTORY='dolly-${DOLLY_TEST_NEVER_SET}-install'

case "${CASE_ID}" in
  SC-11-01-path-with-spaces)
    WEAKENED_EXECUTABLE="${STATE_DIR}/dolly core install/launch core"
    # Whitespace is text a shell would act on, so the path is not an installed
    # path the ADR accepts. The argument vector repeats the path and carries no
    # dollar sign or percent sign, so no expansion refusal joins it.
    EXPECTED_ADDED=(CORE_SERVICE_EXEC_START_PATH_INVALID)
    ;;

  SC-11-02-path-with-variable-like-text)
    WEAKENED_EXECUTABLE="${STATE_DIR}/${VARIABLE_LIKE_DIRECTORY}/launch-core"
    # Two refusals, both exact: the path itself carries a dollar sign, and the
    # argument vector's first entry is that same path, which the ADR reads as
    # variable-like text in an argument.
    EXPECTED_ADDED=(
      CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED
      CORE_SERVICE_EXEC_START_PATH_INVALID
    )
    ;;

  *)
    finish inconclusive unknown-case
    ;;
esac

UNIT_SUFFIX="$(printf '%s' "${CASE_ID}" | tr 'A-Z' 'a-z')"

# ---------------------------------------------------------------------------
# The control service: the same topology behind an installed path ADR 0009
# accepts. It also proves the `:` prefix is in effect, because a service whose
# ExecStart lacked the no-env-expand flag would refuse for that reason alone.
# ---------------------------------------------------------------------------

CONTROL_EXECUTABLE="${STATE_DIR}/dolly-core-install/launch-core"
CONTROL_OUTPUT="${CASE_DIR}/control-observation.json"
run_probe_unit "${UNIT_SUFFIX}-control" "${CONTROL_EXECUTABLE}" "${CONTROL_OUTPUT}"
case "$?" in
  0) ;;
  3) finish inconclusive control-unit-name-refused-by-ledger ;;
  4) finish inconclusive control-unit-would-not-start ;;
  6) finish inconclusive could-not-write-control-program ;;
  *) finish inconclusive control-unit-produced-no-result ;;
esac

CONTROL_CODES="$(probe_codes "${CONTROL_OUTPUT}")" || finish inconclusive control-result-unreadable

observe control-unit "${RUN_UNIT}"
observe control-executable "${CONTROL_EXECUTABLE}"
observe control-main-pid "$(probe_field "${CONTROL_OUTPUT}" observation unit mainPid)"
observe control-self-pid "$(probe_field "${CONTROL_OUTPUT}" observation selfPid)"
observe control-self-cgroup "$(probe_field "${CONTROL_OUTPUT}" observation selfCgroupPath)"
observe control-exec-start "$(probe_field "${CONTROL_OUTPUT}" observation unit execStart)"
observe control-refusal-codes "$(join_set "${CONTROL_CODES}")"

CONTROL_UNEXPECTED="$(set_difference "${CONTROL_CODES}" "${ENVIRONMENT_LIMITATION_CODES}")"
observe control-unexpected-codes "$(join_set "${CONTROL_UNEXPECTED}")"
if [ -n "${CONTROL_UNEXPECTED}" ]; then
  event "the control service refused for reasons beyond the declared host limitations"
  finish inconclusive control-service-not-conformant
fi

# The control's ExecStart must be exactly the installed path, with the prefix
# flag and nothing else. This is the positive half of the case: it shows the
# service manager reporting the ADR's own ExecStart shape.
CONTROL_EXEC_EXPECTED="$(node -e '
  const [path] = process.argv.slice(1);
  console.log(JSON.stringify([{ path, argumentVector: [path], flags: ["no-env-expand"] }]));
' "${CONTROL_EXECUTABLE}")"
CONTROL_EXEC_OBSERVED="$(probe_field "${CONTROL_OUTPUT}" observation unit execStart)"
observe control-exec-start-expected "${CONTROL_EXEC_EXPECTED}"
if [ "${CONTROL_EXEC_OBSERVED}" != "${CONTROL_EXEC_EXPECTED}" ]; then
  event "the control service did not report the expected no-env-expand ExecStart"
  finish inconclusive control-exec-start-not-as-configured
fi

# ---------------------------------------------------------------------------
# The service under test: the same everything, behind the interpreted path.
# ---------------------------------------------------------------------------

WEAKENED_OUTPUT="${CASE_DIR}/weakened-observation.json"
run_probe_unit "${UNIT_SUFFIX}-weakened" "${WEAKENED_EXECUTABLE}" "${WEAKENED_OUTPUT}"
case "$?" in
  0) ;;
  3) finish inconclusive weakened-unit-name-refused-by-ledger ;;
  4) finish inconclusive weakened-unit-would-not-start ;;
  6) finish inconclusive could-not-write-weakened-program ;;
  *) finish inconclusive weakened-unit-produced-no-result ;;
esac

WEAKENED_CODES="$(probe_codes "${WEAKENED_OUTPUT}")" || finish inconclusive weakened-result-unreadable

observe weakened-unit "${RUN_UNIT}"
observe weakened-executable "${WEAKENED_EXECUTABLE}"
observe weakened-main-pid "$(probe_field "${WEAKENED_OUTPUT}" observation unit mainPid)"
observe weakened-self-pid "$(probe_field "${WEAKENED_OUTPUT}" observation selfPid)"
observe weakened-self-cgroup "$(probe_field "${WEAKENED_OUTPUT}" observation selfCgroupPath)"
observe weakened-refusal-codes "$(join_set "${WEAKENED_CODES}")"

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

# The manager must report the path exactly as it was given: unexpanded, with its
# spaces or its literal ${...} text intact, and with the prefix flag set. A
# manager that had expanded the text would have failed to execute anything, so
# the probe's own output is further proof the literal path was the one run.
WEAKENED_EXEC_EXPECTED="$(node -e '
  const [path] = process.argv.slice(1);
  console.log(JSON.stringify([{ path, argumentVector: [path], flags: ["no-env-expand"] }]));
' "${WEAKENED_EXECUTABLE}")"
WEAKENED_EXEC_OBSERVED="$(probe_field "${WEAKENED_OUTPUT}" observation unit execStart)"
observe weakened-exec-start-expected "${WEAKENED_EXEC_EXPECTED}"
observe weakened-exec-start-observed "${WEAKENED_EXEC_OBSERVED}"
if [ "${WEAKENED_EXEC_OBSERVED}" != "${WEAKENED_EXEC_EXPECTED}" ]; then
  event "the service manager did not report the executable path unchanged"
  finish failed executable-path-not-passed-through-unchanged
fi

ADDED="$(set_difference "${WEAKENED_CODES}" "${CONTROL_CODES}")"
REMOVED="$(set_difference "${CONTROL_CODES}" "${WEAKENED_CODES}")"
EXPECTED="$(printf '%s\n' "${EXPECTED_ADDED[@]}")"

observe expected-added-codes "$(join_set "${EXPECTED}")"
observe observed-added-codes "$(join_set "${ADDED}")"
observe observed-removed-codes "$(join_set "${REMOVED}")"

if [ "$(join_set "${ADDED}")" != "$(join_set "${EXPECTED}")" ]; then
  event "the interpreted path did not produce exactly the expected additional refusals"
  finish failed unexpected-additional-refusals
fi
if [ -n "${REMOVED}" ]; then
  event "the interpreted path dropped a refusal the control service reported"
  finish failed refusal-disappeared-under-interpreted-path
fi

finish passed "refused-with-$(join_set "${EXPECTED}" | sed 's/CORE_SERVICE_//g' | tr ',' '.')"
