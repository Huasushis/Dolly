#!/bin/bash
# Case handler: unavailable dependencies must fail closed.
#
# Architecture Decision Record 0009 requires Core to refuse Module work when the
# service manager, control-group delegation, a required controller, the Core
# state store, the Extension protocol channel, the durable records, the finite
# cleanup deadline, or the child launcher's interpreter is unavailable. These
# cases exist to show Core does not continue in a reduced form; reporting an
# error is not on its own the property under test, so every case also asserts a
# step that never happened.
#
# Cases:
#   SC-13-01-systemd-unavailable
#   SC-13-02-delegation-unavailable
#   SC-13-03-controller-unavailable
#   SC-13-04-state-store-unavailable
#   SC-13-05-protocol-channel-unavailable
#   SC-13-06-durable-records-corrupt
#   SC-13-07-cleanup-timeout
#   SC-13-08-python3-interpreter-absent
#
# All but SC-13-02 run inside one transient user service created with
# `Delegate=yes` and `DelegateSubgroup=core`, because a real delegated root is
# what the control-group cases need. SC-13-02 is the exception by design: it
# runs in a unit with no delegation at all, which is the condition it tests.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/dependency-unavailable-driver.mjs"
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
RUN_MARKER="${UNIT_PREFIX%-}"

dolly_ledger_add_unit "${UNIT_LEDGER}" "${UNIT}.service" || finish inconclusive unit-name-refused-by-ledger

# SC-13-02 is the only case whose condition is the absence of delegation, so it
# is the only one whose unit omits `Delegate`. Giving it the delegated topology
# would remove the very thing it tests.
DELEGATION_PROPERTIES=(-p Delegate=yes -p DelegateSubgroup=core)
if [ "${CASE_ID}" = "SC-13-02-delegation-unavailable" ]; then
  DELEGATION_PROPERTIES=()
  event "running without delegation, which is this case's condition"
fi

event "running ${CASE_ID} inside ${UNIT}.service"
systemd-run --user --quiet --pipe --wait --collect "--unit=${UNIT}" \
  -p Type=exec "${DELEGATION_PROPERTIES[@]+"${DELEGATION_PROPERTIES[@]}"}" \
  -- "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" "${CASE_ID}" "${RUN_MARKER}" "${CASE_DIR}" \
  >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
DRIVER_EXIT=$?
event "driver exited ${DRIVER_EXIT}"

systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true

OUTCOME_LINE="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${CASE_DIR}/driver.json" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive outcome-helper-produced-nothing

finish "${STATUS}" "${REASON}"
