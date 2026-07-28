#!/bin/bash
# Case handler: inherited environment sentinels.
#
# Architecture Decision Record 0009 says the Core executable must clear the
# inherited service-manager environment before the Node.js runtime starts, and
# that clearing only the command used to ask systemd to start Core is
# insufficient "because a user service can inherit its user manager's
# environment". These cases put a sentinel where the ADR says the leak comes
# from - the user manager's own environment block - and then require it to be
# absent where the ADR says it must be absent.
#
# Every case sets the sentinel first and proves it really did reach the service,
# so an absence later is evidence about the boundary and not about an experiment
# that forgot to set anything. Environments are read from `/proc/<pid>/environ`,
# which is what the kernel received at `execve`, rather than from a runtime's
# own copy.
#
# Cases:
#   SC-12-01-user-manager-sentinel        the Extension does not observe it
#   SC-12-02-service-manager-sentinel     the Node.js runtime does not observe
#                                         it once Core clears the inherited
#                                         environment
#   SC-12-03-extension-minimal-environment  the Extension observes exactly the
#                                         declared minimal environment
#
# The sentinel is set with `systemctl --user set-environment` and removed again
# on every exit path, including a failed one. Nothing else about the service
# manager is changed: it is never reloaded, restarted, or signalled.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"
CGROUP_LEDGER="${DOLLY_EXPERIMENT_CGROUP_LEDGER:?}"
STATE_DIR="${DOLLY_EXPERIMENT_STATE_DIR:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

DRIVER="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers/extension-environment-probe.mjs"
LAUNCHER_SCRIPT="${REPOSITORY}/src/adapters/linux-module-launcher/launcher.py"
EXTENSION_PROGRAM="${REPOSITORY}/tests/conformance/security/fixtures/module-process-report.py"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

SENTINEL_NAME="DOLLY_TEST_MANAGER_SENTINEL"
SENTINEL_VALUE="dolly-test-sentinel-${DOLLY_EXPERIMENT_SEED:-0}-${CASE_ID}"
# The whole environment a Module process is declared to receive. It must match
# the declaration in the driver, which is the value actually handed to `execve`.
DECLARED_EXTENSION_ENVIRONMENT='{"DOLLY_MODULE_MARKER":"declared-minimal-environment"}'
# The one non-secret value ADR 0009 lets Core keep in its minimal environment.
CORE_MINIMAL_ENVIRONMENT_NAME="DOLLY_CORE_UNIT"

DRIVER_DEADLINE_DECISECONDS=900

: >"${EVENTS}"
: >"${OBSERVATIONS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

observe() {
  printf '%s=%s\n' "$1" "$2" >>"${OBSERVATIONS}"
}

# Removes the sentinel from the service manager and records whether it is gone.
# Registered as an exit trap so no failure path can leave it behind.
clear_sentinel() {
  systemctl --user unset-environment "${SENTINEL_NAME}" >/dev/null 2>&1 || true
  local remaining
  remaining="$(systemctl --user show-environment 2>/dev/null | grep -c "^${SENTINEL_NAME}=")"
  printf 'sentinel-remaining-after-cleanup=%s\n' "${remaining}" >>"${OBSERVATIONS}"
  event "removed the sentinel from the service manager; remaining=${remaining}"
}

finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\n' "${status}" "${reason}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  exit 0
}

[ -f "${DRIVER}" ] || finish inconclusive driver-missing
[ -f "${LAUNCHER_SCRIPT}" ] || finish inconclusive launcher-script-missing
[ -f "${EXTENSION_PROGRAM}" ] || finish inconclusive extension-program-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing
[ -x /usr/bin/python3 ] || finish inconclusive python3-interpreter-missing
[ -x /usr/bin/env ] || finish inconclusive env-command-missing

NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || finish inconclusive node-not-installed
case "${NODE_BIN}" in /*) ;; *) finish inconclusive node-path-not-absolute ;; esac

stop_unit() {
  systemctl --user stop "$1" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1" >/dev/null 2>&1 || true
}

# One value out of a driver result, as compact JSON.
driver_field() {
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

# Starts one transient service that runs the driver as its main process and
# waits for the driver's single result line. Sets RUN_UNIT.
#
# The command is passed as the remaining arguments so a case can choose between
# an ordinary Core command and one that clears the inherited environment first.
run_driver_unit() {
  local suffix="$1" out="$2" delegate="$3"
  shift 3
  local unit="${UNIT_PREFIX}${suffix}"
  RUN_UNIT="${unit}.service"
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${RUN_UNIT}" || return 3
  local -a properties=(-p Type=exec -p "StandardOutput=file:${out}" -p "StandardError=file:${out}.stderr")
  if [ "${delegate}" = "delegated" ]; then
    properties+=(-p Delegate=yes -p DelegateSubgroup=core)
  fi
  : >"${out}"
  event "starting ${RUN_UNIT}"
  if ! systemd-run --user --quiet "--unit=${unit}" "${properties[@]}" -- "$@" \
      >>"${CASE_DIR}/systemd-run.stderr" 2>&1; then
    event "the service manager refused to start ${RUN_UNIT}"
    return 4
  fi
  local waited=0
  while [ "${waited}" -lt "${DRIVER_DEADLINE_DECISECONDS}" ]; do
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

# ---------------------------------------------------------------------------
# The sentinel
# ---------------------------------------------------------------------------

trap clear_sentinel EXIT

if ! systemctl --user set-environment "${SENTINEL_NAME}=${SENTINEL_VALUE}" >/dev/null 2>&1; then
  finish inconclusive could-not-set-service-manager-sentinel
fi
event "placed the sentinel in the service manager environment"

MANAGER_SENTINEL="$(systemctl --user show-environment 2>/dev/null | sed -n "s/^${SENTINEL_NAME}=//p")"
observe sentinel-name "${SENTINEL_NAME}"
observe sentinel-value-configured "${SENTINEL_VALUE}"
observe sentinel-value-in-service-manager "${MANAGER_SENTINEL}"
if [ "${MANAGER_SENTINEL}" != "${SENTINEL_VALUE}" ]; then
  finish inconclusive service-manager-did-not-take-the-sentinel
fi

UNIT_SUFFIX="$(printf '%s' "${CASE_ID}" | tr 'A-Z' 'a-z')"

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

# Runs the driver in `extension` mode inside a delegated service, and records
# the Module control group in the run's ledger before the driver creates it.
# Sets EXTENSION_OUTPUT.
run_extension_case() {
  local module_cgroup_name="${UNIT_PREFIX}module"
  local go_file="${STATE_DIR}/${CASE_ID}.go"
  rm -f "${go_file}"
  EXTENSION_OUTPUT="${CASE_DIR}/extension-observation.json"

  local unit="${UNIT_PREFIX}${UNIT_SUFFIX}-extension"
  RUN_UNIT="${unit}.service"
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${RUN_UNIT}" || return 3
  : >"${EXTENSION_OUTPUT}"
  event "starting ${RUN_UNIT} with a delegated core subgroup"
  if ! systemd-run --user --quiet "--unit=${unit}" \
      -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
      -p "StandardOutput=file:${EXTENSION_OUTPUT}" \
      -p "StandardError=file:${EXTENSION_OUTPUT}.stderr" \
      -- "${NODE_BIN}" --import "file://${TSX_LOADER}" "${DRIVER}" \
         extension "${module_cgroup_name}" "${go_file}" \
      >>"${CASE_DIR}/systemd-run.stderr" 2>&1; then
    event "the service manager refused to start ${RUN_UNIT}"
    return 4
  fi

  # The driver waits for the go file, so the Module control group is recorded
  # before it exists. The path is the service's own delegated root plus the
  # name, and the ledger refuses any name outside this run's reserved prefix.
  local control_group=""
  local waited=0
  while [ "${waited}" -lt 300 ]; do
    control_group="$(systemctl --user show "${RUN_UNIT}" -p ControlGroup --value 2>/dev/null)"
    [ -n "${control_group}" ] && break
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ -z "${control_group}" ]; then
    stop_unit "${RUN_UNIT}"
    event "the service manager reported no control group for ${RUN_UNIT}"
    return 6
  fi
  observe extension-service-control-group "${control_group}"
  if ! dolly_ledger_add_cgroup "${CGROUP_LEDGER}" "/sys/fs/cgroup" "${UNIT_PREFIX}" \
      "/sys/fs/cgroup${control_group}/${module_cgroup_name}"; then
    stop_unit "${RUN_UNIT}"
    return 7
  fi
  observe extension-module-cgroup "/sys/fs/cgroup${control_group}/${module_cgroup_name}"
  : >"${go_file}"
  event "recorded the Module control group and released the driver"

  waited=0
  while [ "${waited}" -lt "${DRIVER_DEADLINE_DECISECONDS}" ]; do
    [ -s "${EXTENSION_OUTPUT}" ] && break
    sleep 0.1
    waited=$((waited + 1))
  done
  event "${RUN_UNIT} active-state=$(systemctl --user show "${RUN_UNIT}" -p ActiveState --value 2>/dev/null) result=$(systemctl --user show "${RUN_UNIT}" -p Result --value 2>/dev/null)"
  stop_unit "${RUN_UNIT}"
  event "stopped ${RUN_UNIT}"
  [ -s "${EXTENSION_OUTPUT}" ] || return 5
  return 0
}

# Records what one extension-mode run observed, and checks the parts every
# extension case depends on. Returns non-zero when the run itself did not get
# far enough to be evidence about the environment boundary.
record_extension_observations() {
  local file="$1"
  observe extension-driver-completed "$(driver_field "${file}" completed)"
  observe extension-driver-error "$(driver_field "${file}" error)"
  observe extension-service-self-cgroup "$(driver_field "${file}" selfCgroup)"
  observe extension-delegated-root-processes "$(driver_field "${file}" extension delegatedRootProcesses)"
  observe extension-delegated-root-subtree-control "$(driver_field "${file}" extension subtreeControl)"
  observe extension-launch-outcome "$(driver_field "${file}" extension outcome outcome)"
  observe extension-process-id "$(driver_field "${file}" extension report processId)"
  observe extension-cgroup "$(driver_field "${file}" extension report cgroup)"
  observe extension-exec-argument-vector "$(driver_field "${file}" extension report execArgumentVector)"
  observe extension-exec-environment "$(driver_field "${file}" extension report execEnvironment)"
  observe extension-module-cgroup-removed "$(driver_field "${file}" extension moduleCgroupRemoved)"
  observe extension-cgroup-events-after-kill "$(driver_field "${file}" extension cgroupEventsAfterKill)"

  [ "$(driver_field "${file}" completed)" = "true" ] || return 1
  [ "$(driver_field "${file}" extension outcome outcome)" = '"executing"' ] || return 2
  [ "$(driver_field "${file}" extension report execEnvironment)" != "null" ] || return 3
  return 0
}

case "${CASE_ID}" in
  SC-12-01-user-manager-sentinel | SC-12-03-extension-minimal-environment)
    run_extension_case
    case "$?" in
      0) ;;
      3) finish inconclusive extension-unit-name-refused-by-ledger ;;
      4) finish inconclusive extension-unit-would-not-start ;;
      6) finish inconclusive extension-service-control-group-unknown ;;
      7) finish inconclusive module-cgroup-refused-by-ledger ;;
      *) finish inconclusive extension-unit-produced-no-result ;;
    esac

    record_extension_observations "${EXTENSION_OUTPUT}"
    case "$?" in
      0) ;;
      1) finish inconclusive driver-did-not-complete ;;
      2) finish inconclusive launcher-did-not-execute-the-extension ;;
      *) finish inconclusive extension-reported-no-execve-environment ;;
    esac

    # The sentinel must really have reached the service. Without this the
    # absence below would be evidence about nothing.
    SERVICE_SENTINEL="$(driver_field "${EXTENSION_OUTPUT}" serviceEnvironment "${SENTINEL_NAME}")"
    observe service-observed-sentinel "${SERVICE_SENTINEL}"
    if [ "${SERVICE_SENTINEL}" != "\"${SENTINEL_VALUE}\"" ]; then
      event "the sentinel did not reach the service, so the case has no positive control"
      finish inconclusive sentinel-did-not-reach-the-service
    fi

    EXTENSION_ENVIRONMENT="$(driver_field "${EXTENSION_OUTPUT}" extension report execEnvironment)"
    EXTENSION_SENTINEL="$(driver_field "${EXTENSION_OUTPUT}" extension report execEnvironment "${SENTINEL_NAME}")"
    observe extension-observed-sentinel "${EXTENSION_SENTINEL}"

    if [ "${CASE_ID}" = "SC-12-01-user-manager-sentinel" ]; then
      if [ "${EXTENSION_SENTINEL}" != "null" ]; then
        event "the Extension observed the service manager sentinel"
        finish failed extension-observed-the-manager-sentinel
      fi
      finish passed sentinel-absent-from-the-extension-environment
    fi

    # SC-12-03 asserts the whole environment, not only the sentinel's absence.
    observe extension-environment-expected "${DECLARED_EXTENSION_ENVIRONMENT}"
    if [ "${EXTENSION_ENVIRONMENT}" != "${DECLARED_EXTENSION_ENVIRONMENT}" ]; then
      event "the Extension environment was not exactly the declared minimal environment"
      finish failed extension-environment-not-exactly-declared
    fi
    finish passed extension-environment-exactly-the-declared-minimum
    ;;

  SC-12-02-service-manager-sentinel)
    # The inheriting arm is the hazard ADR 0009 names: an ordinary service
    # command carries the user manager's environment straight into the runtime.
    INHERITING_OUTPUT="${CASE_DIR}/inheriting-observation.json"
    run_driver_unit "${UNIT_SUFFIX}-inheriting" "${INHERITING_OUTPUT}" plain \
      "${NODE_BIN}" "${DRIVER}" service-environment
    case "$?" in
      0) ;;
      3) finish inconclusive inheriting-unit-name-refused-by-ledger ;;
      4) finish inconclusive inheriting-unit-would-not-start ;;
      *) finish inconclusive inheriting-unit-produced-no-result ;;
    esac
    INHERITING_UNIT="${RUN_UNIT}"
    INHERITING_SENTINEL="$(driver_field "${INHERITING_OUTPUT}" serviceEnvironment "${SENTINEL_NAME}")"
    observe inheriting-unit "${INHERITING_UNIT}"
    observe inheriting-runtime-observed-sentinel "${INHERITING_SENTINEL}"
    observe inheriting-runtime-environment-names \
      "$(driver_field "${INHERITING_OUTPUT}" serviceEnvironment | node -e '
        let raw = ""; process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(raw);
          console.log(JSON.stringify(Object.keys(value ?? {}).sort()));
        });
      ')"
    if [ "${INHERITING_SENTINEL}" != "\"${SENTINEL_VALUE}\"" ]; then
      event "an ordinary service command did not inherit the sentinel, so the case has no positive control"
      finish inconclusive sentinel-did-not-reach-the-runtime
    fi

    # The conformant arm is the ADR's own requirement: the Core command clears
    # the inherited service-manager environment before the Node.js runtime
    # starts, and declares the one non-secret value it keeps.
    CLEARED_OUTPUT="${CASE_DIR}/cleared-observation.json"
    CLEARED_UNIT_NAME="${UNIT_PREFIX}${UNIT_SUFFIX}-cleared.service"
    run_driver_unit "${UNIT_SUFFIX}-cleared" "${CLEARED_OUTPUT}" plain \
      /usr/bin/env -i "${CORE_MINIMAL_ENVIRONMENT_NAME}=${CLEARED_UNIT_NAME}" \
      "${NODE_BIN}" "${DRIVER}" service-environment
    case "$?" in
      0) ;;
      3) finish inconclusive cleared-unit-name-refused-by-ledger ;;
      4) finish inconclusive cleared-unit-would-not-start ;;
      *) finish inconclusive cleared-unit-produced-no-result ;;
    esac
    CLEARED_ENVIRONMENT="$(driver_field "${CLEARED_OUTPUT}" serviceEnvironment)"
    CLEARED_EXPECTED="$(node -e '
      const [name, value] = process.argv.slice(1);
      console.log(JSON.stringify({ [name]: value }));
    ' "${CORE_MINIMAL_ENVIRONMENT_NAME}" "${CLEARED_UNIT_NAME}")"
    observe cleared-unit "${RUN_UNIT}"
    observe cleared-runtime-environment-observed "${CLEARED_ENVIRONMENT}"
    observe cleared-runtime-environment-expected "${CLEARED_EXPECTED}"
    if [ "${CLEARED_ENVIRONMENT}" != "${CLEARED_EXPECTED}" ]; then
      event "the Node.js runtime environment was not exactly the declared minimal environment"
      finish failed runtime-environment-not-exactly-declared
    fi
    finish passed sentinel-absent-once-core-clears-the-inherited-environment
    ;;

  *)
    finish inconclusive unknown-case
    ;;
esac
