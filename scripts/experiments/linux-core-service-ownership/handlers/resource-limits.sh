#!/bin/bash
# Case handler: enforced Module resource limits.
#
# Architecture Decision Record 0009 requires Core to prove, with real
# processes, that a Module's memory, process count, processor rate, open files,
# protocol frames, result size, and elapsed time are actually bounded, and that
# a memory breach ends the whole process group rather than one allocating
# process. Required failure test 6 makes those tests a condition of accepting
# the decision.
#
# Cases:
#   LM-01-memory          memory.max plus memory.oom.group ends the whole group
#   LM-02-process-count   pids.max refuses a real fork with a real errno
#   LM-03-processor-rate  cpu.max throttles a real processor loop
#   LM-04-open-files      the launcher's RLIMIT_NOFILE holds before exec
#   LM-05-protocol-frame  Core refuses an oversized protocol frame
#   LM-06-result-size     Core refuses an oversized capability result
#   LM-07-elapsed-time    a finite deadline ends the whole control group
#
# Each case runs inside one transient user service this run's prefix reserves,
# created with `Delegate=yes` and `DelegateSubgroup=core`. Everything the case
# creates lives inside that service's own delegated subtree, so the service's
# own teardown is a second line of cleanup behind the handler's.
#
# The real work is in `resource-limits-driver.mjs`, which calls the production
# implementations rather than reimplementing them. This file exists to create
# the service, run the driver in it, and write the artifacts the runner
# requires.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/resource-limits-driver.mjs"
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

# Every exit path goes through here, so the case always has a readable status
# rather than defaulting to unreadable.
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
PYTHON_BINARY="$(command -v python3 || true)"
[ -n "${PYTHON_BINARY}" ] || finish inconclusive python3-not-found

# A unit name systemd accepts, derived only from the case identifier.
UNIT_SUFFIX="$(printf '%s' "${CASE_ID}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
UNIT="${UNIT_PREFIX}${UNIT_SUFFIX}"
RUN_MARKER="${UNIT_PREFIX%-}"

dolly_ledger_add_unit "${UNIT_LEDGER}" "${UNIT}.service" || finish inconclusive unit-name-refused-by-ledger

event "running ${CASE_ID} inside ${UNIT}.service"
systemd-run --user --quiet --pipe --wait --collect "--unit=${UNIT}" \
  -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
  -- "${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" "${CASE_ID}" "${RUN_MARKER}" \
  >"${CASE_DIR}/driver.json" 2>"${CASE_DIR}/driver.stderr"
DRIVER_EXIT=$?
event "driver exited ${DRIVER_EXIT}"

# The unit ran with --collect, so it removes itself. Stopping it again is
# harmless and keeps a partial run from leaving it active.
systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true

OUTCOME_LINE="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${CASE_DIR}/driver.json" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive outcome-helper-produced-nothing

finish "${STATUS}" "${REASON}"
