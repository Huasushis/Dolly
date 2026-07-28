#!/bin/bash
# Case handler: untrusted-fixture escape attempts.
#
# Architecture Decision Record 0009 required failure test 6 asks for an
# untrusted sandbox fixture that fails every cgroup-change, cgroup-escape,
# Core-signal, Core-state, manager-control, inherited-descriptor, other-process
# `/proc` state, filesystem, network, or subprocess escape attempt. The fixture
# is `fixture-escape.py`: a fixed local script that takes no command-line or
# environment input, signals only a process carrying one fixed sentinel this
# run created, opens rather than writes where the question is whether the
# authority exists, contacts no host but the loopback address, and ends on a
# fixed alarm.
#
# Cases SC-14-01 to SC-14-11; each runs the fixture once as a real Module
# process inside a real prepared Module control group, started by the reviewed
# child launcher, and judges its own attempts.
#
# Containment: everything happens inside one transient user service this run's
# prefix reserves, created with `Delegate=yes` and `DelegateSubgroup=core`. The
# driver terminates the whole group, removes any control group the fixture
# created, and stops the Core stand-in before it reports; the service's own
# teardown with `--collect` is the second line of cleanup behind that.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/sandbox-escape-driver.mjs"
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
[ -f "${HANDLERS}/fixture-escape.py" ] || finish inconclusive hostile-fixture-missing

NODE_BINARY="$(command -v node || true)"
[ -n "${NODE_BINARY}" ] || finish inconclusive node-not-found
PYTHON_BINARY="$(command -v python3 || true)"
[ -n "${PYTHON_BINARY}" ] || finish inconclusive python3-not-found

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

systemctl --user stop "${UNIT}.service" >/dev/null 2>&1 || true
systemctl --user reset-failed "${UNIT}.service" >/dev/null 2>&1 || true

OUTCOME_LINE="$("${NODE_BINARY}" "${OUTCOME_HELPER}" "${CASE_DIR}/driver.json" "${OBSERVATIONS}" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive outcome-helper-produced-nothing

finish "${STATUS}" "${REASON}"
