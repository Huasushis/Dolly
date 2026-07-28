#!/bin/bash
# Case handler: service manager, session, and machine lifecycle events.
#
# Architecture Decision Record 0009 claims that a Module process is owned by a
# control group, not by a parent-child relationship, so every lifecycle event
# that ends Core must end the whole Module group. These cases are what makes
# that claim falsifiable: each event case starts a fixture that forks a
# descendant, snapshots both process identifiers, performs the event, and then
# requires the group to hold no process *and* the descendant to be gone. Proving
# only that Core's direct child exited would prove nothing.
#
# Cases:
#   SC-03-01-core-service-restart        restart the Core service itself
#   SC-03-02-user-manager-restart        restart the systemd user manager
#   SC-03-03-login-end-with-lingering    end the last login session, lingering on
#   SC-03-04-login-end-without-lingering end the last login session, lingering off
#   SC-03-05-machine-reboot              reboot the machine and recover
#   SC-03-06-same-boot-missing-cgroup-path
#   SC-03-07-changed-boot-identifier
#
# Every wait here is a wait for a condition the setup role announced in the
# barrier file, never a fixed delay.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/lifecycle-driver.mjs"
OUTCOME_HELPER="${HANDLERS}/driver-outcome.mjs"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
BARRIERS="${CASE_DIR}/barrier-snapshots"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"
: >"${BARRIERS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\n' "${status}" "${reason}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  exit 0
}

[ -f "${DRIVER}" ] || finish inconclusive case-driver-missing
[ -f "${OUTCOME_HELPER}" ] || finish inconclusive outcome-helper-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing

NODE_BINARY="$(command -v node || true)"
[ -n "${NODE_BINARY}" ] || finish inconclusive node-not-found

UNIT_SUFFIX="$(printf '%s' "${CASE_ID}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
UNIT="${UNIT_PREFIX}${UNIT_SUFFIX}"
RUN_MARKER="${UNIT_PREFIX%-}"

dolly_ledger_add_unit "${UNIT_LEDGER}" "${UNIT}.service" || finish inconclusive unit-name-refused-by-ledger

stop_unit() {
  systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
  systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true
}

run_driver_role() {
  local role="$1"
  "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" \
    "${CASE_ID}" "${role}" "${RUN_MARKER}" "${CASE_DIR}"
}

report_from() {
  local file="$1"
  local line status reason
  line="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${file}" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
  status="${line%%$'\t'*}"
  reason="${line#*$'\t'}"
  [ -n "${status}" ] || finish inconclusive outcome-helper-produced-nothing
  finish "${status}" "${reason}"
}

# Waits until the setup role announces the named barrier. This is a wait for an
# announced condition; it never assumes an elapsed time is enough.
await_barrier() {
  local name="$1" deadline=$((SECONDS + 90))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if grep -q "barrier ${name} reached" "${BARRIERS}" 2>/dev/null; then
      event "barrier ${name} reached"
      return 0
    fi
    if ! systemctl --user is-active --quiet "${UNIT}.service" 2>/dev/null; then
      # The setup unit died before announcing. Waiting longer cannot help.
      event "setup unit is no longer active before barrier ${name}"
      return 1
    fi
    sleep 0.2
  done
  event "barrier ${name} was never reached"
  return 1
}

# ---------------------------------------------------------------------------
# Recovery-evidence cases run one driver inside one delegated transient unit.
# ---------------------------------------------------------------------------
case "${CASE_ID}" in
  SC-03-06-same-boot-missing-cgroup-path|SC-03-07-changed-boot-identifier)
    event "running ${CASE_ID} inside ${UNIT}.service"
    systemd-run --user --quiet --pipe --wait --collect "--unit=${UNIT}" \
      -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
      -- "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" \
         "${CASE_ID}" "single" "${RUN_MARKER}" "${CASE_DIR}" \
      >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
    event "driver exited $?"
    stop_unit
    report_from "${CASE_DIR}/driver.json"
    ;;
esac

# ---------------------------------------------------------------------------
# Event cases: start the setup role as a real service, wait for its barrier,
# snapshot its state, perform the event, then evaluate.
# ---------------------------------------------------------------------------
start_setup_unit() {
  event "starting ${UNIT}.service with the setup role"
  systemd-run --user --quiet "--unit=${UNIT}" \
    -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
    -p KillMode=control-group -p SendSIGKILL=yes -p TimeoutStopSec=20 \
    -- "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" \
       "${CASE_ID}" "setup" "${RUN_MARKER}" "${CASE_DIR}" \
    >/dev/null 2>&1
}

evaluate() {
  run_driver_role decide >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
  report_from "${CASE_DIR}/driver.json"
}

case "${CASE_ID}" in
  SC-03-01-core-service-restart)
    start_setup_unit || finish inconclusive setup-unit-could-not-start
    await_barrier module-group-populated || { stop_unit; finish inconclusive setup-barrier-not-reached; }
    cp "${CASE_DIR}/setup.json" "${CASE_DIR}/setup-before.json" 2>/dev/null \
      || { stop_unit; finish inconclusive setup-state-not-written; }
    event "restarting ${UNIT}.service"
    systemctl --user restart "${UNIT}.service" >/dev/null 2>&1
    event "restart returned $?"
    # The replacement invocation builds its own group; this case is about the
    # one that existed before the restart, so the unit is stopped again before
    # the evaluation reads the snapshot.
    stop_unit
    evaluate
    ;;

  SC-03-02-user-manager-restart)
    # RUN THIS CASE ON ITS OWN.
    #
    # Ending the user manager is the event under test, and an unprivileged
    # account cannot start it again: `user@<uid>.service` belongs to the system
    # manager. A measured run confirmed the consequence — every later case in
    # the same run failed with "Failed to connect to bus", because `systemd-run
    # --user` and `loginctl` need the manager this case destroys. The handler
    # therefore restores what it can and records plainly when it cannot, and the
    # case must be selected on its own, for example with
    # `--id-prefix SC-03-02`.
    start_setup_unit || finish inconclusive setup-unit-could-not-start
    await_barrier module-group-populated || { stop_unit; finish inconclusive setup-barrier-not-reached; }
    cp "${CASE_DIR}/setup.json" "${CASE_DIR}/setup-before.json" 2>/dev/null \
      || { stop_unit; finish inconclusive setup-state-not-written; }
    event "ending the systemd user manager"
    systemctl --user exit >/dev/null 2>&1
    event "user manager exit returned $?"
    # Wait for the manager to come back if the environment can bring it back.
    # This is a bounded wait on an observable condition, and its result is
    # recorded either way rather than assumed.
    MANAGER_BACK=no
    for _ in $(seq 1 60); do
      if systemctl --user is-system-running >/dev/null 2>&1; then
        MANAGER_BACK=yes
        break
      fi
      sleep 0.5
    done
    event "user manager reachable again: ${MANAGER_BACK}"
    if [ "${MANAGER_BACK}" = "no" ]; then
      printf 'the systemd user manager did not return; an unprivileged account cannot start user@<uid>.service, so any further case in this run would fail for that reason rather than its own\n' \
        >>"${OBSERVATIONS}"
    fi
    stop_unit
    evaluate
    ;;

  SC-03-03-login-end-with-lingering|SC-03-04-login-end-without-lingering)
    WANT_LINGER=no
    [ "${CASE_ID}" = "SC-03-03-login-end-with-lingering" ] && WANT_LINGER=yes
    CURRENT_LINGER="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
    event "lingering is currently ${CURRENT_LINGER}, this case needs ${WANT_LINGER}"
    if [ "${CURRENT_LINGER}" = "unknown" ]; then
      finish inconclusive lingering-state-unreadable
    fi
    if [ "${CURRENT_LINGER}" != "${WANT_LINGER}" ]; then
      if ! loginctl "$([ "${WANT_LINGER}" = "yes" ] && echo enable-linger || echo disable-linger)" \
           "$(id -un)" >/dev/null 2>&1; then
        finish inconclusive lingering-state-not-settable-without-privilege
      fi
      event "lingering set to ${WANT_LINGER}"
    fi
    SESSIONS="$(loginctl list-sessions --no-legend 2>/dev/null | wc -l | tr -d ' ')"
    event "login sessions for this user: ${SESSIONS}"
    if [ "${SESSIONS}" = "0" ]; then
      # There is no login session to end, so the interruption point this case
      # names does not occur in this environment.
      finish inconclusive no-login-session-to-terminate
    fi
    start_setup_unit || finish inconclusive setup-unit-could-not-start
    await_barrier module-group-populated || { stop_unit; finish inconclusive setup-barrier-not-reached; }
    cp "${CASE_DIR}/setup.json" "${CASE_DIR}/setup-before.json" 2>/dev/null \
      || { stop_unit; finish inconclusive setup-state-not-written; }
    event "terminating every login session of this user"
    loginctl terminate-user "$(id -un)" >/dev/null 2>&1
    event "terminate-user returned $?"
    for _ in $(seq 1 60); do
      systemctl --user is-system-running >/dev/null 2>&1 && break
      sleep 0.5
    done
    stop_unit
    evaluate
    ;;

  SC-03-05-machine-reboot)
    # A reboot ends the process performing it. The runner, this handler, and the
    # artifact directory all live inside the environment that would restart, so
    # this handler cannot both cause the reboot and evaluate what followed it.
    # Recording that honestly is required; a case that cannot be performed is
    # never reported as passing.
    event "a reboot would terminate this handler and the runner that invoked it"
    finish inconclusive reboot-requires-an-orchestrator-outside-the-rebooted-environment
    ;;
esac

finish inconclusive unknown-case
