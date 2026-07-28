#!/bin/bash
# Case handler: the `baseline-direct-child` arm of the fixed interruption
# matrix, 210 cases.
#
# The experiment protocol's "Baselines" section defines this arm as "the current
# direct child `ExtensionProcessHost` outside a validated stable service, which
# is expected to prove cleanup only while its creating Core process remains
# alive". This handler runs exactly that: the real `ExtensionProcessHost` from
# `src/core/extension-process-host.ts`, owned by an ordinary process that is not
# the main process of any systemd service, driven to the same fifteen
# interruption points, with the same child fixture, deadlines, and result
# payloads as the proposed arm. `baseline-fixture-contract.md` records every
# shared value so a reviewer can confirm neither arm was tuned.
#
# The protocol also says a baseline is not weakened to make the proposal look
# better. That cuts both ways, and two choices here follow from it:
#
#   * the child fixture exits when its inherited channel closes, which is what
#     the shipped conformance fixture does and what the security specification
#     requires. A fixture that refused to exit would make this arm look worse
#     than it is; and
#   * where this arm cannot perform a durable boundary, the driver attempts the
#     real operation and records the real refusal, rather than skipping the step
#     or substituting something the shipped code does not do.
#
# Case identity, for example
# `FM-M08.completion-after-active-capability-handler-baseline-direct-child`,
# gives the boundary, the timing, and the workload.
#
# Sequence:
#   1. start the Core stand-in and wait for it to reach the named boundary;
#   2. record what of the old generation is alive at that exact point;
#   3. terminate the Core stand-in with SIGKILL;
#   4. record what outlived it;
#   5. run a successor Core that has only the durable state and the operating
#      system, and record what it can prove; then
#   6. remove every process this case created and prove none remains.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
STATE_DIR="${DOLLY_EXPERIMENT_STATE_DIR:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"

HANDLERS="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/handlers"
DRIVER="${HANDLERS}/baseline-core-driver.mjs"
SUCCESSOR="${HANDLERS}/baseline-successor-probe.mjs"
EVALUATOR="${HANDLERS}/baseline-direct-child-evaluate.mjs"
PROPOSED_FIXTURE="${REPOSITORY}/scripts/experiments/linux-core-service-ownership/core-standin/dolly-protocol-extension-fixture.py"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"

EVENTS="${CASE_DIR}/events"
BARRIERS="${CASE_DIR}/barrier-snapshots"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${BARRIERS}"
: >"${OBSERVATIONS}"

# Part of the shared contract: how long the harness waits for the Core stand-in
# to reach its interruption point, and how long it gives a process of the old
# generation to disappear once its creating Core is gone. The observation window
# is longer than the fixture's processor loop, so a child that is merely busy is
# never mistaken for one that survived.
BARRIER_WAIT_SECONDS=90
SURVIVAL_OBSERVATION_MS=3000

SENTINEL=""
WORK_DIR=""
CORE_PID=""
DESCENDANT_PID=0
DESCENDANT_START=""

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

cmdline_of() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null
}

# A process counts as this case's only when its own command line still carries
# this case's sentinel, which begins with the run's reserved prefix. The
# identifier alone is never trusted, because the operating system may have
# reused it.
is_ours() {
  local pid="$1" line
  [ -n "${pid}" ] || return 1
  [ "${pid}" -gt 0 ] 2>/dev/null || return 1
  line="$(cmdline_of "${pid}")"
  [ -n "${line}" ] || return 1
  [[ "${line}" == *"${SENTINEL}"* ]]
}

# The `process-descendant` workload starts an ordinary `sleep` that carries no
# marker of its own, matching the proposed arm's fixture. It is identified by
# its process identifier together with its start time from `/proc/<pid>/stat`
# field 22, which names one exact process even after the identifier is reused.
# The identifier alone is never trusted.
is_descendant() {
  local stat rest start
  [ "${DESCENDANT_PID:-0}" -gt 0 ] 2>/dev/null || return 1
  [ -n "${DESCENDANT_START}" ] || return 1
  stat="$(cat "/proc/${DESCENDANT_PID}/stat" 2>/dev/null)" || return 1
  rest="${stat##*) }"
  start="$(printf '%s' "${rest}" | cut -d' ' -f20)"
  [ "${start}" = "${DESCENDANT_START}" ]
}

# Kills exactly the processes this case created. This is harness cleanup, not
# baseline recovery: the arm itself has no such handle after its Core exits,
# which is the finding each case records.
kill_case_processes() {
  local pid
  if [ -n "${SENTINEL}" ]; then
    for pid in $(pgrep -f "${SENTINEL}" 2>/dev/null || true); do
      [ "${pid}" = "$$" ] && continue
      if is_ours "${pid}"; then
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    done
  fi
  if is_descendant; then
    kill -KILL "${DESCENDANT_PID}" 2>/dev/null || true
  fi
}

# Every process of this case that is still alive, as a JSON array.
surviving_json() {
  local role_default="$1" first="yes" pid out="["
  if [ -n "${SENTINEL}" ]; then
    for pid in $(pgrep -f "${SENTINEL}" 2>/dev/null || true); do
      [ "${pid}" = "$$" ] && continue
      if is_ours "${pid}"; then
        [ "${first}" = "yes" ] && first="no" || out="${out},"
        out="${out}{\"pid\":${pid},\"role\":\"${role_default}\"}"
      fi
    done
  fi
  if is_descendant; then
    [ "${first}" = "yes" ] && first="no" || out="${out},"
    out="${out}{\"pid\":${DESCENDANT_PID},\"role\":\"${role_default}\"}"
  fi
  printf '%s]' "${out}"
}

finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\ncase=%s\n' "${status}" "${reason}" "${CASE_ID}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  if [ -n "${WORK_DIR}" ] && [ -f "${WORK_DIR}/driver-events" ]; then
    cat "${WORK_DIR}/driver-events" >>"${EVENTS}"
  fi
  exit 0
}

trap 'kill_case_processes' EXIT

[ -f "${DRIVER}" ] || finish inconclusive case-driver-missing
[ -f "${SUCCESSOR}" ] || finish inconclusive successor-probe-missing
[ -f "${EVALUATOR}" ] || finish inconclusive evaluator-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing

NODE_BINARY="$(command -v node || true)"
[ -n "${NODE_BINARY}" ] || finish inconclusive node-not-found
# The shared child fixture is the proposed arm's own file, executed rather than
# reimplemented, so the protocol's "same child fixture" holds structurally.
PYTHON3_BINARY="$(command -v python3 || true)"
[ -n "${PYTHON3_BINARY}" ] || finish inconclusive python3-not-found
[ -f "${PROPOSED_FIXTURE}" ] || finish inconclusive shared-extension-fixture-missing

# ---------------------------------------------------------------------------
# Case identity
# ---------------------------------------------------------------------------
REST="${CASE_ID%-baseline-direct-child}"
[ "${REST}" != "${CASE_ID}" ] || finish inconclusive case-identifier-not-in-this-arm
REST="${REST#FM-}"
BOUNDARY="${REST%%-*}"
REST="${REST#*-}"
TIMING="${REST%%-*}"
WORKLOAD="${REST#*-}"

case "${TIMING}" in before|after) ;; *) finish inconclusive unrecognised-timing ;; esac
case "${WORKLOAD}" in
  no-output|single-output|multiple-output-pages|processor-loop|process-descendant|active-capability-handler|unknown-external-effect) ;;
  *) finish inconclusive unrecognised-workload ;;
esac

CASE_SLUG="$(printf '%s' "${CASE_ID}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]' | cut -c1-48)"
SENTINEL="${UNIT_PREFIX}${CASE_SLUG}"
# No unit is created: running outside a validated stable service is this arm's
# defining condition. The name is handed to the real binding inspector so its
# refusal is recorded rather than assumed.
UNIT_NAME="${UNIT_PREFIX}absent-core.service"

WORK_DIR="${STATE_DIR}/${CASE_ID}"
mkdir -p "${WORK_DIR}" || finish inconclusive work-directory-not-created

event "case ${CASE_ID} boundary=${BOUNDARY} timing=${TIMING} workload=${WORKLOAD}"

# ---------------------------------------------------------------------------
# 1. Run the Core stand-in to the interruption point
# ---------------------------------------------------------------------------
event "starting the Core stand-in outside any systemd service"
"${NODE_BINARY}" --import "file://${TSX_LOADER}" "${DRIVER}" \
  --boundary "${BOUNDARY}" \
  --timing "${TIMING}" \
  --workload "${WORKLOAD}" \
  --work-dir "${WORK_DIR}" \
  --repository "${REPOSITORY}" \
  --sentinel "${SENTINEL}" \
  --unit-name "${UNIT_NAME}" \
  --python3 "${PYTHON3_BINARY}" \
  >"${CASE_DIR}/driver.stdout" 2>"${CASE_DIR}/driver.stderr" &
DRIVER_SHELL_PID=$!

waited_ms=0
while [ ! -f "${WORK_DIR}/barrier-ready" ]; do
  kill -0 "${DRIVER_SHELL_PID}" 2>/dev/null || break
  sleep 0.1
  waited_ms=$((waited_ms + 100))
  [ "${waited_ms}" -ge $((BARRIER_WAIT_SECONDS * 1000)) ] && break
done

if [ ! -f "${WORK_DIR}/barrier-ready" ]; then
  wait "${DRIVER_SHELL_PID}" 2>/dev/null
  driver_exit=$?
  [ -f "${WORK_DIR}/barrier.json" ] && cat "${WORK_DIR}/barrier.json" >>"${BARRIERS}"
  [ -f "${CASE_DIR}/driver.stderr" ] && cat "${CASE_DIR}/driver.stderr" >>"${OBSERVATIONS}"
  event "driver exited ${driver_exit} without stopping at a barrier"
  # A Run with no output commits no Block and appends no output Delivery, so
  # those two interruption points do not exist for that workload. The point is
  # missing from the Run itself, not from this arm, so the proposed design
  # reports the same four cases the same way. This is the only case in this arm
  # where nothing could be judged; everywhere else a boundary this arm cannot
  # perform is still reported `failed`, because the invariant is real and
  # unmet.
  if [ -f "${WORK_DIR}/boundary-structurally-absent" ]; then
    kill_case_processes
    sleep 0.3
    printf 'boundary-structurally-absent %s\n' "$(cat "${WORK_DIR}/boundary-structurally-absent")" >>"${OBSERVATIONS}"
    printf 'residual-processes-after-cleanup %s\n' "$(surviving_json residual)" >>"${OBSERVATIONS}"
    finish not-applicable boundary-does-not-exist-for-a-run-with-no-output
  fi
  if [ -f "${WORK_DIR}/boundary-not-reached" ]; then
    finish inconclusive boundary-not-reached
  fi
  finish inconclusive core-standin-did-not-reach-the-barrier
fi

CORE_PID="$(tr -cd '[:digit:]' <"${WORK_DIR}/barrier-ready")"
event "barrier reached; Core stand-in ${CORE_PID} is held at ${BOUNDARY} ${TIMING}"
cat "${WORK_DIR}/barrier.json" >>"${BARRIERS}"

EXTENSION_PID=0
[ -f "${WORK_DIR}/extension-pid" ] && EXTENSION_PID="$(tr -cd '[:digit:]' <"${WORK_DIR}/extension-pid")"
# The shared fixture records the descendant as the identifier on the first line
# and, when it could read it, the start time from `/proc/<pid>/stat` on the
# second. Both lines are parsed separately: joining them would produce a number
# that is neither. If the fixture recorded no start time, it is read here while
# the process is still alive at the barrier. The pair identifies one exact
# process for the rest of the case even if the identifier is reused.
if [ -f "${WORK_DIR}/descendant-pid" ]; then
  { read -r DESCENDANT_PID; read -r DESCENDANT_START; } <"${WORK_DIR}/descendant-pid" || true
  DESCENDANT_PID="$(printf '%s' "${DESCENDANT_PID:-}" | tr -cd '[:digit:]')"
  DESCENDANT_PID="${DESCENDANT_PID:-0}"
  DESCENDANT_START="$(printf '%s' "${DESCENDANT_START:-}" | tr -cd '[:digit:]')"
  if [ -z "${DESCENDANT_START}" ] && [ "${DESCENDANT_PID}" -gt 0 ] 2>/dev/null && [ -r "/proc/${DESCENDANT_PID}/stat" ]; then
    DESCENDANT_START="$(sed 's/.*) //' "/proc/${DESCENDANT_PID}/stat" 2>/dev/null | cut -d' ' -f20)"
  fi
fi
PROCESS_GENERATION="bpg0"
[ -f "${WORK_DIR}/process-generation-id" ] && PROCESS_GENERATION="$(tr -cd '[:alnum:]' <"${WORK_DIR}/process-generation-id")"

# ---------------------------------------------------------------------------
# 2. What of the old generation is alive at the exact interruption point
# ---------------------------------------------------------------------------
ALIVE_AT_BARRIER="["
alive_first="yes"
add_alive() {
  [ "${alive_first}" = "yes" ] && alive_first="no" || ALIVE_AT_BARRIER="${ALIVE_AT_BARRIER},"
  ALIVE_AT_BARRIER="${ALIVE_AT_BARRIER}{\"pid\":$1,\"role\":\"$2\"}"
}
is_ours "${CORE_PID}" && add_alive "${CORE_PID}" core
is_ours "${EXTENSION_PID}" && add_alive "${EXTENSION_PID}" extension
is_descendant && add_alive "${DESCENDANT_PID}" descendant
ALIVE_AT_BARRIER="${ALIVE_AT_BARRIER}]"
event "alive at barrier ${ALIVE_AT_BARRIER}"

# The control-group observation. This arm creates no Module control group, so
# what is recorded is where the child actually runs: inside Core's own group.
{
  printf 'case %s\n' "${CASE_ID}"
  printf 'boundary %s timing %s workload %s\n' "${BOUNDARY}" "${TIMING}" "${WORKLOAD}"
  printf 'core-pid %s cgroup %s\n' "${CORE_PID}" "$(sed -n 's/^0:://p' "/proc/${CORE_PID}/cgroup" 2>/dev/null || echo unknown)"
  if [ "${EXTENSION_PID:-0}" -gt 0 ] 2>/dev/null; then
    printf 'extension-pid %s cgroup %s\n' "${EXTENSION_PID}" "$(sed -n 's/^0:://p' "/proc/${EXTENSION_PID}/cgroup" 2>/dev/null || echo gone)"
  else
    printf 'extension-pid none\n'
  fi
  if [ "${DESCENDANT_PID:-0}" -gt 0 ] 2>/dev/null; then
    printf 'descendant-pid %s cgroup %s\n' "${DESCENDANT_PID}" "$(sed -n 's/^0:://p' "/proc/${DESCENDANT_PID}/cgroup" 2>/dev/null || echo gone)"
  else
    printf 'descendant-pid none\n'
  fi
  printf 'module-cgroup none: this arm creates no delegated Module control group\n'
  printf 'alive-at-barrier %s\n' "${ALIVE_AT_BARRIER}"
} >>"${OBSERVATIONS}"

# ---------------------------------------------------------------------------
# 3. Terminate the Core stand-in with SIGKILL
# ---------------------------------------------------------------------------
event "sending SIGKILL to the Core stand-in ${CORE_PID}"
kill -KILL "${CORE_PID}" 2>/dev/null || true
core_gone_ms=0
while kill -0 "${CORE_PID}" 2>/dev/null; do
  sleep 0.05
  core_gone_ms=$((core_gone_ms + 50))
  [ "${core_gone_ms}" -ge 5000 ] && break
done
wait "${DRIVER_SHELL_PID}" 2>/dev/null
event "Core stand-in gone after ${core_gone_ms}ms"

# ---------------------------------------------------------------------------
# 4. What outlived it
# ---------------------------------------------------------------------------
sleep "$(awk "BEGIN { print ${SURVIVAL_OBSERVATION_MS} / 1000 }")"

SURVIVORS="["
survivor_first="yes"
add_survivor() {
  [ "${survivor_first}" = "yes" ] && survivor_first="no" || SURVIVORS="${SURVIVORS},"
  SURVIVORS="${SURVIVORS}{\"pid\":$1,\"role\":\"$2\"}"
}
is_ours "${EXTENSION_PID}" && add_survivor "${EXTENSION_PID}" extension
is_descendant && add_survivor "${DESCENDANT_PID}" descendant
SURVIVORS="${SURVIVORS}]"
event "survivors after ${SURVIVAL_OBSERVATION_MS}ms ${SURVIVORS}"
printf 'survivors-after-core-sigkill %s\n' "${SURVIVORS}" >>"${OBSERVATIONS}"

# ---------------------------------------------------------------------------
# 5. The successor Core, with only the durable state and the operating system
# ---------------------------------------------------------------------------
event "starting the successor Core"
"${NODE_BINARY}" --import "file://${TSX_LOADER}" "${SUCCESSOR}" \
  --work-dir "${WORK_DIR}" \
  --repository "${REPOSITORY}" \
  --unit-name "${UNIT_NAME}" \
  --process-generation "${PROCESS_GENERATION}" \
  >"${CASE_DIR}/successor.stdout" 2>"${CASE_DIR}/successor.stderr"
successor_exit=$?
event "successor exited ${successor_exit}"
[ -f "${WORK_DIR}/successor.json" ] && cat "${WORK_DIR}/successor.json" >>"${BARRIERS}"

# ---------------------------------------------------------------------------
# 6. Remove every process this case created and prove none remains
# ---------------------------------------------------------------------------
kill_case_processes
sleep 0.5
RESIDUE="$(surviving_json residual)"
event "residual processes after cleanup ${RESIDUE}"
printf 'residual-processes-after-cleanup %s\n' "${RESIDUE}" >>"${OBSERVATIONS}"

cat >"${WORK_DIR}/observations.json" <<OBSERVATION_JSON
{
  "aliveAtBarrier": ${ALIVE_AT_BARRIER},
  "aliveAfterCoreDeath": ${SURVIVORS},
  "residualProcessesAfterCleanup": ${RESIDUE},
  "coreTerminationSignal": "SIGKILL",
  "survivalObservationMs": ${SURVIVAL_OBSERVATION_MS}
}
OBSERVATION_JSON

OUTCOME_LINE="$("${NODE_BINARY}" "${EVALUATOR}" \
  "${WORK_DIR}/barrier.json" \
  "${WORK_DIR}/observations.json" \
  "${WORK_DIR}/successor.json" \
  "${CASE_DIR}/invariant-evaluation.json" 2>>"${OBSERVATIONS}")"
STATUS="${OUTCOME_LINE%%$'\t'*}"
REASON="${OUTCOME_LINE#*$'\t'}"
[ -n "${STATUS}" ] || finish inconclusive evaluator-produced-nothing

[ -f "${CASE_DIR}/invariant-evaluation.json" ] && cat "${CASE_DIR}/invariant-evaluation.json" >>"${OBSERVATIONS}"

finish "${STATUS}" "${REASON}"
