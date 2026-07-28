#!/bin/bash
# Case handler: process identifier reuse pressure.
#
# Linux reuses process identifiers, so an identifier saved before a restart is
# not evidence about the process that saved it. This case forces the exact
# collision and requires two things of the production recovery path: it still
# proves the old Module process stopped, from control-group evidence, and it
# sends nothing to the identifier, which is observable because the unrelated
# process now holding that identifier survives.
#
# Case:
#   SC-05-01-identifier-reuse-pressure
#
# The catalog marks this case disruptive: forcing an exact identifier needs a
# writable `/proc/sys/kernel/ns_last_pid`, which is why it runs in the
# disposable container rather than on a shared host.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/pid-reuse-driver.mjs"
OUTCOME_HELPER="${HANDLERS}/driver-outcome.mjs"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"
: >"${CASE_DIR}/barrier-snapshots"

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

event "ns_last_pid writable: $([ -w /proc/sys/kernel/ns_last_pid ] && echo yes || echo no)"

event "running ${CASE_ID} inside ${UNIT}.service"
systemd-run --user --quiet --pipe --wait --collect "--unit=${UNIT}" \
  -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
  -- "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" "${CASE_ID}" "${RUN_MARKER}" "${CASE_DIR}" \
  >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
event "driver exited $?"

systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true

OUTCOME_LINE="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${CASE_DIR}/driver.json" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive outcome-helper-produced-nothing

finish "${STATUS}" "${REASON}"
