#!/bin/bash
# Case handler: exhausting the finite service restart limit.
#
# Architecture Decision Record 0009 requires a finite restart limit and requires
# that exhausting it leaves a visibly failed service with Modules disabled. An
# endless restart loop is the outcome this case exists to exclude, so the
# handler creates a unit that always fails, lets its finite limit run out, and
# then requires both halves: the service manager reports `failed`, and the
# production activation decision refuses to start Modules against that unit.
#
# Case:
#   SC-04-01-exhaust-finite-restart-limit
#
# The wait below is a wait for the unit to reach a terminal state, polled from
# the service manager. It is not a fixed delay, and it fails rather than passing
# if the unit is still restarting when the bound expires: a unit still looping
# is exactly the defect under test.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/restart-limit-driver.mjs"
OUTCOME_HELPER="${HANDLERS}/driver-outcome.mjs"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"

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

dolly_ledger_add_unit "${UNIT_LEDGER}" "${UNIT}.service" || finish inconclusive unit-name-refused-by-ledger

# A finite limit: at most two starts in a sixty-second window, restarting on
# failure. The program always fails, so the limit is what stops the loop.
RESTART_BURST=2
event "creating ${UNIT}.service with StartLimitBurst=${RESTART_BURST}"
if ! systemd-run --user --quiet "--unit=${UNIT}" \
     -p Type=exec -p Restart=on-failure -p RestartSec=100ms \
     -p "StartLimitBurst=${RESTART_BURST}" -p StartLimitIntervalSec=60 \
     -- /bin/false >/dev/null 2>&1; then
  finish inconclusive could-not-create-restart-limited-unit
fi

show() {
  systemctl --user show "${UNIT}.service" -p "$1" --value 2>/dev/null
}

# Wait for a terminal state. A unit that is still activating or restarting when
# this bound expires has not stopped looping, which is a failure of the property
# under test rather than an inconclusive environment problem.
DEADLINE=$((SECONDS + 90))
ACTIVE_STATE=""
while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
  ACTIVE_STATE="$(show ActiveState)"
  case "${ACTIVE_STATE}" in
    failed|inactive) break ;;
  esac
  sleep 0.2
done

SUB_STATE="$(show SubState)"
RESULT="$(show Result)"
RESTARTS="$(show NRestarts)"
event "ActiveState=${ACTIVE_STATE} SubState=${SUB_STATE} Result=${RESULT} NRestarts=${RESTARTS}"
{
  printf 'ActiveState=%s\nSubState=%s\nResult=%s\nNRestarts=%s\n' \
    "${ACTIVE_STATE}" "${SUB_STATE}" "${RESULT}" "${RESTARTS}"
  systemctl --user show "${UNIT}.service" \
    -p Restart -p StartLimitBurst -p StartLimitIntervalUSec -p RestartUSec 2>/dev/null
} >"${CASE_DIR}/unit-state.txt"

if [ -z "${ACTIVE_STATE}" ] || [ "${ACTIVE_STATE}" = "activating" ] || \
   [ "${ACTIVE_STATE}" = "reloading" ]; then
  # Still cycling after a bounded wait: the restart limit did not stop it.
  event "the unit was still cycling when the bound expired"
  printf 'the unit was still in ActiveState=%s after 90 s, so its restart limit did not stop it\n' \
    "${ACTIVE_STATE}" >>"${OBSERVATIONS}"
  finish failed restart-limit-did-not-stop-the-loop
fi

"${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" \
  "${CASE_ID}" "${UNIT}.service" "${ACTIVE_STATE}" "${SUB_STATE}" "${RESULT}" "${RESTARTS}" \
  >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
event "driver exited $?"

systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true

OUTCOME_LINE="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${CASE_DIR}/driver.json" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive outcome-helper-produced-nothing

finish "${STATUS}" "${REASON}"
