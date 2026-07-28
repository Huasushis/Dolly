#!/bin/bash
# Case handler: `BL-transient-unit-delayed-creation`, the whole
# `baseline-transient-unit` arm.
#
# The experiment protocol's "Baselines" section admits the rejected
# per-generation transient systemd service from Architecture Decision Record
# 0008 for one purpose only: "a deterministic delayed creation reproduction",
# and "never as a proposed fallback". Nothing in this handler is a design
# anyone may adopt; it exists to show, on a real service manager, that the first
# reason ADR 0008 was rejected is reachable.
#
# ADR 0008, Reasons For Rejection, item 1:
#
#   "Persisting a `starting` record does not prove that the request to create
#    the service has completed. An old `systemd-run` process may be paused
#    before it asks systemd to create the service. A successor controller can
#    then observe `not-found`, start a replacement, and later see the old
#    request create a second service. Absence is not final while an earlier
#    creation request can still arrive."
#
# The reproduction makes each of those five moments explicit and deterministic,
# with no sleep-based timing anywhere in the race itself:
#
#   1. controller A persists a `starting` record naming the first unit;
#   2. controller A launches the creation request as a process that stops
#      itself with SIGSTOP *before* it executes `systemd-run`, so the request
#      provably has not reached the service manager;
#   3. controller A is terminated with SIGKILL;
#   4. controller B queries the unit, observes `not-found`, and starts a
#      replacement generation, exactly as ADR 0008 says it may; then
#   5. the paused request is released with SIGCONT and creates its service.
#
# The observation is whether two Module process generations are then live at
# once. Both generations run the same child fixture as the other baseline and
# the proposed arm, launched through the same node binary, so the reproduction
# measures the launch mechanism and nothing else.
#
# Every unit is recorded in the run's ledger under the run's reserved prefix
# before it is created, and the case removes exactly what it created.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
STATE_DIR="${DOLLY_EXPERIMENT_STATE_DIR:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
FIXTURE="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/core-standin/dolly-protocol-extension-fixture.py"

EVENTS="${CASE_DIR}/events"
BARRIERS="${CASE_DIR}/barrier-snapshots"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${BARRIERS}"
: >"${OBSERVATIONS}"

# The protocol repeats delayed-send cases 100 times across ten fixed seeds. The
# runner does not implement repetition yet, so this handler repeats within its
# own deadline and records how many iterations it actually ran; the recorded
# count is the honest one, not the protocol's target.
MAX_ITERATIONS=5
TIME_BUDGET_SECONDS=200
UNIT_STATE_WAIT_SECONDS=15

SENTINEL=""
WORK_DIR=""
STARTED_UNITS=()

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

cmdline_of() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null
}

count_with() {
  local token="$1" pid total=0
  for pid in $(pgrep -f "${token}" 2>/dev/null || true); do
    [ "${pid}" = "$$" ] && continue
    local line
    line="$(cmdline_of "${pid}")"
    [[ "${line}" == *"${token}"* ]] && total=$((total + 1))
  done
  printf '%s' "${total}"
}

stop_started_units() {
  local unit
  for unit in ${STARTED_UNITS[@]+"${STARTED_UNITS[@]}"}; do
    [ -n "${unit}" ] || continue
    systemctl --user stop "${unit}" >/dev/null 2>&1 || true
    systemctl --user reset-failed "${unit}" >/dev/null 2>&1 || true
  done
}

# Nothing here removes a unit name that did not come from this run's own ledger
# helper, which refuses any name outside the reserved test prefix.

kill_case_processes() {
  [ -n "${SENTINEL}" ] || return 0
  local pid line
  for pid in $(pgrep -f "${SENTINEL}" 2>/dev/null || true); do
    [ "${pid}" = "$$" ] && continue
    line="$(cmdline_of "${pid}")"
    if [[ "${line}" == *"${SENTINEL}"* ]]; then
      # A stopped process cannot act on SIGKILL until it is continued.
      kill -CONT "${pid}" 2>/dev/null || true
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
}

release_channel() {
  # Closing the shared standard-input channel gives every remaining fixture the
  # end of input its specification tells it to exit on.
  exec 9>&- 2>/dev/null || true
}

finish() {
  local status="$1" reason="$2"
  release_channel
  stop_started_units
  kill_case_processes
  printf 'status=%s\nreason=%s\ncase=%s\niterations=%s\n' \
    "${status}" "${reason}" "${CASE_ID}" "${ITERATIONS_RUN:-0}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  exit 0
}

trap 'release_channel; stop_started_units; kill_case_processes' EXIT

[ "${CASE_ID}" = "BL-transient-unit-delayed-creation" ] || finish inconclusive unknown-case
[ -f "${FIXTURE}" ] || finish inconclusive shared-extension-fixture-missing

PYTHON3_BINARY="$(command -v python3 || true)"
[ -n "${PYTHON3_BINARY}" ] || finish inconclusive python3-not-found
command -v systemd-run >/dev/null 2>&1 || finish inconclusive systemd-run-not-found

SENTINEL="${UNIT_PREFIX}transientunit"
WORK_DIR="${STATE_DIR}/${CASE_ID}"
mkdir -p "${WORK_DIR}" || finish inconclusive work-directory-not-created

# The child fixture waits for `dolly.initialize` on standard input. Under a
# transient service there is no Core on the other end, so the harness supplies a
# channel that stays open: a named pipe held open read-write for the whole case.
# This is deliberately the same fixture file the other arms run; only the launch
# mechanism differs, which is what the reproduction is about.
CHANNEL="${WORK_DIR}/module-channel"
rm -f "${CHANNEL}"
mkfifo "${CHANNEL}" 2>/dev/null || finish inconclusive named-pipe-not-created
exec 9<>"${CHANNEL}" || finish inconclusive named-pipe-not-opened

start_generation() {
  local unit="$1" sentinel="$2"
  systemd-run --user --quiet "--unit=${unit%.service}" \
    -p Type=exec \
    -p "StandardInput=file:${CHANNEL}" \
    -p StandardOutput=null \
    -p StandardError=null \
    -- "${PYTHON3_BINARY}" -I -B "${FIXTURE}" "${sentinel}" >/dev/null 2>&1
}

wait_for_active() {
  local unit="$1" waited=0
  while [ "${waited}" -lt $((UNIT_STATE_WAIT_SECONDS * 10)) ]; do
    [ "$(systemctl --user show "${unit}" -p ActiveState --value 2>/dev/null)" = "active" ] && return 0
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# Preflight: this reproduction is only meaningful if the mechanism it inspects
# works at all here. A service that cannot be created is a harness fact, not an
# ADR 0008 result.
# ---------------------------------------------------------------------------
PREFLIGHT_UNIT="${UNIT_PREFIX}tupre.service"
dolly_ledger_add_unit "${UNIT_LEDGER}" "${PREFLIGHT_UNIT}" || finish inconclusive unit-name-refused-by-ledger
STARTED_UNITS+=("${PREFLIGHT_UNIT}")
if ! start_generation "${PREFLIGHT_UNIT}" "${SENTINEL}pre"; then
  finish inconclusive transient-service-could-not-be-created
fi
if ! wait_for_active "${PREFLIGHT_UNIT}"; then
  finish inconclusive transient-service-did-not-become-active
fi
if [ "$(count_with "${SENTINEL}pre")" -lt 1 ]; then
  finish inconclusive fixture-did-not-stay-live-under-a-transient-service
fi
systemctl --user stop "${PREFLIGHT_UNIT}" >/dev/null 2>&1 || true
systemctl --user reset-failed "${PREFLIGHT_UNIT}" >/dev/null 2>&1 || true
event "preflight: a transient service can hold a live child fixture here"

# ---------------------------------------------------------------------------
# The reproduction
# ---------------------------------------------------------------------------
STARTED_AT="$(date +%s)"
ITERATIONS_RUN=0
OVERLAPS=0
SUCCESSOR_SAW_NOT_FOUND=0
ITERATION_RECORDS=""

for iteration in $(seq 1 "${MAX_ITERATIONS}"); do
  [ $(( $(date +%s) - STARTED_AT )) -lt "${TIME_BUDGET_SECONDS}" ] || break

  GEN1_UNIT="${UNIT_PREFIX}tu${iteration}a.service"
  GEN2_UNIT="${UNIT_PREFIX}tu${iteration}b.service"
  GEN1_SENTINEL="${SENTINEL}i${iteration}g1"
  GEN2_SENTINEL="${SENTINEL}i${iteration}g2"
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${GEN1_UNIT}" || finish inconclusive unit-name-refused-by-ledger
  dolly_ledger_add_unit "${UNIT_LEDGER}" "${GEN2_UNIT}" || finish inconclusive unit-name-refused-by-ledger
  STARTED_UNITS+=("${GEN1_UNIT}" "${GEN2_UNIT}")

  ITERATION_DIR="${WORK_DIR}/iteration-${iteration}"
  mkdir -p "${ITERATION_DIR}"

  # 1 and 2. Controller A persists its `starting` record and launches the
  # creation request in a process that stops itself before `systemd-run` runs.
  event "iteration ${iteration}: controller A persists a starting record for ${GEN1_UNIT}"
  bash -c '
    set -u
    directory="$1"
    unit="$2"
    shift 2
    printf "{\"state\":\"starting\",\"unit\":\"%s\",\"processGeneration\":\"gen1\"}\n" "${unit}" \
      >"${directory}/process-record.json"
    "$@" &
    printf "%s\n" "$!" >"${directory}/creation-request-pid"
    sleep 300
  ' _ "${ITERATION_DIR}" "${GEN1_UNIT}" \
    bash "${HANDLERS}/baseline-paused-creation-request.sh" \
    systemd-run --user --quiet "--unit=${GEN1_UNIT%.service}" \
      -p Type=exec \
      -p "StandardInput=file:${CHANNEL}" \
      -p StandardOutput=null \
      -p StandardError=null \
      -- "${PYTHON3_BINARY}" -I -B "${FIXTURE}" "${GEN1_SENTINEL}" \
    >"${ITERATION_DIR}/controller-a.log" 2>&1 &
  CONTROLLER_A=$!

  waited=0
  while [ ! -f "${ITERATION_DIR}/creation-request-pid" ] && [ "${waited}" -lt 100 ]; do
    sleep 0.05
    waited=$((waited + 1))
  done
  [ -f "${ITERATION_DIR}/creation-request-pid" ] || finish inconclusive creation-request-not-launched
  REQUEST_PID="$(tr -cd '[:digit:]' <"${ITERATION_DIR}/creation-request-pid")"

  # The request must be provably stopped before the service manager hears about
  # it. `T` in the third field of /proc/<pid>/stat is the stopped state.
  waited=0
  request_state=""
  while [ "${waited}" -lt 200 ]; do
    request_state="$(sed 's/.*) //' "/proc/${REQUEST_PID}/stat" 2>/dev/null | cut -d' ' -f1)"
    [ "${request_state}" = "T" ] && break
    sleep 0.05
    waited=$((waited + 1))
  done
  if [ "${request_state}" != "T" ]; then
    kill -KILL "${CONTROLLER_A}" 2>/dev/null || true
    finish inconclusive creation-request-did-not-pause
  fi
  event "iteration ${iteration}: creation request ${REQUEST_PID} is stopped before systemd-run executes"
  GEN1_BEFORE="$(systemctl --user show "${GEN1_UNIT}" -p LoadState --value 2>/dev/null)"

  # 3. Controller A dies. The paused request stays in the harness's own process
  # group, so it is not an orphaned process group and the kernel does not
  # continue it; only this handler decides when it is released.
  kill -KILL "${CONTROLLER_A}" 2>/dev/null || true
  wait "${CONTROLLER_A}" 2>/dev/null
  event "iteration ${iteration}: controller A terminated with SIGKILL"

  # 4. Controller B observes the unit and starts a replacement.
  GEN1_LOAD="$(systemctl --user show "${GEN1_UNIT}" -p LoadState --value 2>/dev/null)"
  GEN1_ACTIVE="$(systemctl --user show "${GEN1_UNIT}" -p ActiveState --value 2>/dev/null)"
  event "iteration ${iteration}: successor observes ${GEN1_UNIT} LoadState=${GEN1_LOAD} ActiveState=${GEN1_ACTIVE}"
  observed_not_found="no"
  if [ "${GEN1_LOAD}" = "not-found" ] || [ "${GEN1_ACTIVE}" = "inactive" ]; then
    observed_not_found="yes"
    SUCCESSOR_SAW_NOT_FOUND=$((SUCCESSOR_SAW_NOT_FOUND + 1))
  fi
  replacement_started="no"
  if [ "${observed_not_found}" = "yes" ] && start_generation "${GEN2_UNIT}" "${GEN2_SENTINEL}"; then
    if wait_for_active "${GEN2_UNIT}"; then
      replacement_started="yes"
      event "iteration ${iteration}: successor started replacement ${GEN2_UNIT}"
    fi
  fi

  # 5. The delayed creation request is released.
  kill -CONT "${REQUEST_PID}" 2>/dev/null || true
  gen1_became_active="no"
  wait_for_active "${GEN1_UNIT}" && gen1_became_active="yes"
  event "iteration ${iteration}: released the delayed request; ${GEN1_UNIT} active=${gen1_became_active}"

  GEN1_COUNT="$(count_with "${GEN1_SENTINEL}")"
  GEN2_COUNT="$(count_with "${GEN2_SENTINEL}")"
  overlapped="no"
  if [ "${GEN1_COUNT}" -ge 1 ] && [ "${GEN2_COUNT}" -ge 1 ]; then
    overlapped="yes"
    OVERLAPS=$((OVERLAPS + 1))
  fi
  ITERATIONS_RUN=$((ITERATIONS_RUN + 1))

  {
    printf 'iteration %s\n' "${iteration}"
    printf '  load-state-before-release %s\n' "${GEN1_BEFORE:-not-found}"
    printf '  successor-observed %s / %s -> replacement-started=%s\n' "${GEN1_LOAD}" "${GEN1_ACTIVE}" "${replacement_started}"
    printf '  after-release gen1-active=%s gen1-processes=%s gen2-processes=%s\n' \
      "${gen1_became_active}" "${GEN1_COUNT}" "${GEN2_COUNT}"
    printf '  two-live-generations-for-one-module %s\n' "${overlapped}"
    printf '  gen1-cgroup %s\n' "$(systemctl --user show "${GEN1_UNIT}" -p ControlGroup --value 2>/dev/null || echo unknown)"
    printf '  gen2-cgroup %s\n' "$(systemctl --user show "${GEN2_UNIT}" -p ControlGroup --value 2>/dev/null || echo unknown)"
  } >>"${OBSERVATIONS}"

  ITERATION_RECORDS="${ITERATION_RECORDS}{\"iteration\":${iteration},\"successorObservedAbsent\":\"${observed_not_found}\",\"replacementStarted\":\"${replacement_started}\",\"delayedUnitBecameActive\":\"${gen1_became_active}\",\"gen1Processes\":${GEN1_COUNT},\"gen2Processes\":${GEN2_COUNT},\"overlapped\":\"${overlapped}\"},"

  systemctl --user stop "${GEN1_UNIT}" >/dev/null 2>&1 || true
  systemctl --user stop "${GEN2_UNIT}" >/dev/null 2>&1 || true
  systemctl --user reset-failed "${GEN1_UNIT}" >/dev/null 2>&1 || true
  systemctl --user reset-failed "${GEN2_UNIT}" >/dev/null 2>&1 || true
done

cat >"${BARRIERS}" <<SNAPSHOT
{
  "arm": "baseline-transient-unit",
  "source": "adr-0008:reasons-for-rejection#1",
  "iterationsRun": ${ITERATIONS_RUN},
  "successorObservedAbsentCount": ${SUCCESSOR_SAW_NOT_FOUND},
  "overlappingGenerationCount": ${OVERLAPS},
  "iterations": [${ITERATION_RECORDS%,}]
}
SNAPSHOT

release_channel
stop_started_units
kill_case_processes
sleep 0.5
RESIDUAL="$(count_with "${SENTINEL}")"
printf 'residual-fixture-processes-after-cleanup %s\n' "${RESIDUAL}" >>"${OBSERVATIONS}"
event "cleanup complete; ${RESIDUAL} residual fixture process(es)"

if [ "${ITERATIONS_RUN}" -eq 0 ]; then
  finish inconclusive no-iteration-completed
fi
if [ "${RESIDUAL}" -ne 0 ]; then
  finish failed residue-after-cleanup
fi
if [ "${OVERLAPS}" -gt 0 ]; then
  # The reproduction succeeded: an absent unit was not final, and the rejected
  # design allowed two Module process generations to be live at once.
  finish failed two-module-generations-overlapped-after-delayed-creation
fi
if [ "${SUCCESSOR_SAW_NOT_FOUND}" -eq 0 ]; then
  finish inconclusive successor-never-observed-the-unit-as-absent
fi
# Not reproducing the race in a handful of iterations is not evidence that the
# rejected design is safe, so this is inconclusive rather than passing.
finish inconclusive delayed-creation-overlap-did-not-reproduce
