#!/bin/bash
# Case handler: Module termination while the Core service stays alive.
#
# The fixed interruption matrix kills Core and asks what the restarted Core
# reconciles. This group asks the opposite question: Core is never interrupted,
# and what is terminated is one Module. ADR 0009 requires every such
# termination. Once a Module cgroup member is observed, an ordinary hard
# timeout, orderly stop, failure cleanup, and replacement use whole-control-
# group termination, `cgroup.events` reporting `populated 0`, and directory
# removal. Before any member is observed, cleanup instead requires observed
# launcher exit, a fresh empty-state reading, and directory removal. A direct
# child exit, a process-group signal, or a recovered process identifier is
# never sufficient after membership was observed.
#
# The case that makes the difference observable is the one with a descendant.
# The fixture starts it with `start_new_session`, so it leaves the Extension's
# process group: an implementation that signalled the process group would leave
# it running and the group would never report `populated 0`.
#
# What runs is the shared `core-standin/core-standin.mts` in its
# `live-termination` mode, so this handler introduces no second subprocess
# protocol. Everything it asserts is read from kernel control-group files and
# from the service manager, never from a report the stand-in makes about itself.
#
# The stand-in's own limits apply: it speaks this experiment's Extension
# protocol rather than `ExtensionProcessHost`, so a pass is evidence about the
# ownership and termination boundary design, not evidence that ADR 0009 can be
# delivered on the code as it stands.
#
# Case identifier: LC-<reason>-<before|after>-membership-<no|with>-descendant
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"
RUN_STATE_DIR="${DOLLY_EXPERIMENT_STATE_DIR:?}"
SYSTEMCTL_SCOPE="${DOLLY_EXPERIMENT_SYSTEMCTL_SCOPE:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

EVENTS="${CASE_DIR}/events"
SNAPSHOTS="${CASE_DIR}/barrier-snapshots"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"
mkdir -p "${SNAPSHOTS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" >>"${EVENTS}"
}

observe() {
  printf '%s\n' "$1" >>"${OBSERVATIONS}"
}

UNIT=""
UNIT_FILE=""

teardown() {
  [ -n "${UNIT}" ] || return 0
  systemctl "${SYSTEMCTL_SCOPE}" stop "${UNIT}" >/dev/null 2>&1 || true
  systemctl "${SYSTEMCTL_SCOPE}" reset-failed "${UNIT}" >/dev/null 2>&1 || true
  [ -n "${UNIT_FILE}" ] && rm -f "${UNIT_FILE}"
  systemctl "${SYSTEMCTL_SCOPE}" daemon-reload >/dev/null 2>&1 || true
}
trap teardown EXIT

finish() {
  printf 'status=%s\nreason=%s\n' "$1" "$2" >"${OUTCOME}"
  event "outcome $1 $2"
  exit 0
}

# ---------------------------------------------------------------------------
# Case identity and preconditions
# ---------------------------------------------------------------------------

if [[ ! "${CASE_ID}" =~ ^LC-(hard-timeout|orderly-stop|failure-cleanup|replacement)-(before|after)-membership-(no|with)-descendant$ ]]; then
  finish inconclusive unrecognised-case-identifier
fi
REASON="${BASH_REMATCH[1]}"
MEMBERSHIP="${BASH_REMATCH[2]}"
DESCENDANT_WORD="${BASH_REMATCH[3]}"
DESCENDANT="none"
[ "${DESCENDANT_WORD}" = "with" ] && DESCENDANT="forked"

if [ "${SYSTEMCTL_SCOPE}" != "--user" ]; then
  finish inconclusive this-handler-implements-only-the-user-service-scope
fi

EXPERIMENT_DIR="${REPOSITORY}/scripts/experiments/linux-core-service-ownership"
STANDIN="${EXPERIMENT_DIR}/core-standin/core-standin.mts"
FIXTURE="${EXPERIMENT_DIR}/core-standin/extension-fixture.py"
LAUNCHER="${REPOSITORY}/src/adapters/linux-module-launcher/launcher.py"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVALUATOR="${EXPERIMENT_DIR}/handlers/live-core-termination-evaluate.mjs"

NODE_PROGRAM="$(command -v node 2>/dev/null || true)"
PYTHON_PROGRAM="$(command -v python3 2>/dev/null || true)"

# The reason names the missing file. A bare `required-file-missing` says only
# that the case could not start, which leaves the reader to guess between five
# paths and an unexpected repository root; the basename is inside the reason
# vocabulary the runner accepts, so it costs nothing to say which one.
for required in "${STANDIN}" "${FIXTURE}" "${LAUNCHER}" "${TSX_LOADER}" "${EVALUATOR}"; do
  [ -f "${required}" ] || finish inconclusive "required-file-missing-$(basename "${required}")"
done
[ -n "${NODE_PROGRAM}" ] || finish inconclusive node-not-found
[ -n "${PYTHON_PROGRAM}" ] || finish inconclusive python3-not-found
case "${NODE_PROGRAM}" in
  /*) ;;
  *) finish inconclusive node-path-is-not-absolute ;;
esac

# ---------------------------------------------------------------------------
# The service under test
# ---------------------------------------------------------------------------

UNIT="${UNIT_PREFIX}${CASE_ID#LC-}.service"
dolly_ledger_add_unit "${UNIT_LEDGER}" "${UNIT}" \
  || finish inconclusive unit-name-refused-by-ledger

WORK_DIR="${RUN_STATE_DIR}/${CASE_ID}"
STANDIN_STATE="${WORK_DIR}/state"
BARRIER_DIR="${CASE_DIR}/barrier"
CONFIGURATION="${WORK_DIR}/configuration.json"
mkdir -p "${STANDIN_STATE}" "${BARRIER_DIR}"

UNIT_DIRECTORY="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
mkdir -p "${UNIT_DIRECTORY}" || finish inconclusive cannot-create-unit-directory
UNIT_FILE="${UNIT_DIRECTORY}/${UNIT}"

node -e '
  const fs = require("node:fs");
  const [out, ...pairs] = process.argv.slice(1);
  const configuration = {};
  for (let index = 0; index < pairs.length; index += 2) {
    configuration[pairs[index]] = pairs[index + 1];
  }
  fs.writeFileSync(out, JSON.stringify(configuration, null, 2) + "\n");
' "${CONFIGURATION}" \
  caseId "${CASE_ID}" \
  unitName "${UNIT}" \
  serviceMode user \
  stateDirectory "${STANDIN_STATE}" \
  barrierDirectory "${BARRIER_DIR}" \
  mode live-termination \
  terminationReason "${REASON}" \
  membershipTiming "${MEMBERSHIP}" \
  descendant "${DESCENDANT}" \
  boundary M00 \
  timing before \
  workload live-termination \
  instanceId "dolly-test-instance" \
  moduleId "experimentworker" \
  moduleGenerationId "dolly-test-module-generation-1" \
  interpreterProgram "${PYTHON_PROGRAM}" \
  launcherScriptPath "${LAUNCHER}" \
  extensionFixturePath "${FIXTURE}" \
  || finish inconclusive could-not-write-standin-configuration

# The same effective settings the fixed interruption matrix uses, because the
# case is about the Module's termination inside a correctly configured Core
# service, not about a different service configuration.
cat >"${UNIT_FILE}" <<UNITFILE
[Unit]
Description=Dolly live Core termination Core stand-in (${CASE_ID})
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
Restart=on-failure
RestartSec=200ms
KillMode=control-group
SendSIGKILL=yes
TimeoutStopSec=20s
Delegate=yes
DelegateSubgroup=core
ExitType=main
RestartMode=normal
RemainAfterExit=no
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=:${NODE_PROGRAM} --import file://${TSX_LOADER} ${STANDIN} ${CONFIGURATION}
UNITFILE

systemctl "${SYSTEMCTL_SCOPE}" daemon-reload >/dev/null 2>&1 \
  || finish inconclusive daemon-reload-failed

event "starting ${UNIT} reason=${REASON} membership=${MEMBERSHIP} descendant=${DESCENDANT}"
if ! systemctl "${SYSTEMCTL_SCOPE}" start "${UNIT}" >"${CASE_DIR}/systemctl-start.log" 2>&1; then
  cp "${CASE_DIR}/systemctl-start.log" "${SNAPSHOTS}/systemctl-start.log" 2>/dev/null || true
  finish inconclusive core-service-would-not-start
fi

FIRST_INVOCATION_ID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p InvocationID --value 2>/dev/null)"
CONTROL_GROUP="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p ControlGroup --value 2>/dev/null)"
FIRST_MAIN_PID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p MainPID --value 2>/dev/null)"
event "unit started invocation=${FIRST_INVOCATION_ID} cgroup=${CONTROL_GROUP} mainpid=${FIRST_MAIN_PID}"

# ---------------------------------------------------------------------------
# Wait for the stand-in's report, deterministically
# ---------------------------------------------------------------------------

REPORT="${BARRIER_DIR}/report-1.json"
CGROUP_ROOT="/sys/fs/cgroup${CONTROL_GROUP}"
MODULE_CGROUPS_DURING="${CASE_DIR}/module-cgroups-during-run"
: >"${MODULE_CGROUPS_DURING}"

# The service manager clears `InvocationID`, `MainPID`, and `NRestarts` once a
# unit goes inactive, and this stand-in exits by itself when it is done. The
# readings are therefore taken on every poll and the last non-empty one is kept,
# so the evidence is from while the unit was still running. Nothing here sleeps
# a fixed interval and then assumes the run is over.
LAST_INVOCATION_ID="${FIRST_INVOCATION_ID}"
LAST_MAIN_PID="${FIRST_MAIN_PID}"
RESTARTS="0"
reported="no"
for _ in $(seq 1 4000); do
  current_invocation="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p InvocationID --value 2>/dev/null)"
  [ -n "${current_invocation}" ] && LAST_INVOCATION_ID="${current_invocation}"
  current_pid="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p MainPID --value 2>/dev/null)"
  { [ -n "${current_pid}" ] && [ "${current_pid}" != "0" ]; } && LAST_MAIN_PID="${current_pid}"
  current_restarts="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p NRestarts --value 2>/dev/null)"
  [ -n "${current_restarts}" ] && RESTARTS="${current_restarts}"

  # Every Module control group this run created, gathered while they exist.
  if [ -d "${CGROUP_ROOT}" ]; then
    find "${CGROUP_ROOT}" -maxdepth 1 -type d -name 'dolly-module-*' 2>/dev/null \
      >>"${MODULE_CGROUPS_DURING}" || true
  fi

  if [ -f "${REPORT}" ]; then reported="yes"; break; fi
  if ! systemctl "${SYSTEMCTL_SCOPE}" is-active --quiet "${UNIT}" 2>/dev/null; then
    sleep 0.2
    [ -f "${REPORT}" ] && reported="yes"
    break
  fi
  sleep 0.05
done

# The polling loop appends, so the same group appears many times.
if [ -s "${MODULE_CGROUPS_DURING}" ]; then
  sort -u "${MODULE_CGROUPS_DURING}" -o "${MODULE_CGROUPS_DURING}"
fi

journalctl "${SYSTEMCTL_SCOPE}" -u "${UNIT}" --no-pager -n 400 \
  >"${SNAPSHOTS}/journal.txt" 2>/dev/null || true

if [ "${reported}" != "yes" ]; then
  cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
  observe "the stand-in never wrote a live-termination report"
  teardown
  finish inconclusive standin-did-not-report-before-deadline
fi

event "stand-in reported; invocation=${LAST_INVOCATION_ID} restarts=${RESTARTS}"
observe "Core service: first invocation ${FIRST_INVOCATION_ID}, last observed ${LAST_INVOCATION_ID}, NRestarts=${RESTARTS}"
observe "Core service: first main process ${FIRST_MAIN_PID}, last observed ${LAST_MAIN_PID}"

cp "${REPORT}" "${SNAPSHOTS}/report-1.json" 2>/dev/null || true
[ -f "${BARRIER_DIR}/trace-1" ] && cat "${BARRIER_DIR}/trace-1" >>"${EVENTS}"

systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" \
  -p MainPID -p InvocationID -p ControlGroup -p ActiveState -p SubState \
  -p NRestarts -p Type -p Restart -p KillMode -p SendSIGKILL -p Delegate \
  -p DelegateSubgroup -p ExitType -p RestartMode -p RemainAfterExit \
  -p TimeoutStopUSec -p ExecStartEx \
  >"${SNAPSHOTS}/unit-properties" 2>/dev/null || true

while IFS= read -r module_cgroup; do
  [ -n "${module_cgroup}" ] || continue
  name="$(basename "${module_cgroup}")"
  observe "module control group observed during the run: ${name}"
  if [ -d "${module_cgroup}" ]; then
    mkdir -p "${SNAPSHOTS}/cgroups/${name}"
    for control in cgroup.procs cgroup.events cgroup.controllers memory.max pids.max cpu.max; do
      [ -r "${module_cgroup}/${control}" ] || continue
      cp "${module_cgroup}/${control}" "${SNAPSHOTS}/cgroups/${name}/${control}" 2>/dev/null || true
    done
    observe "  still present after the run: $(tr '\n' ' ' <"${module_cgroup}/cgroup.events" 2>/dev/null)"
  else
    observe "  removed by the time the run finished"
  fi
done <"${MODULE_CGROUPS_DURING}"

# ---------------------------------------------------------------------------
# Stop the service and prove this case left nothing behind
# ---------------------------------------------------------------------------

teardown
UNIT=""

for _ in $(seq 1 60); do
  [ -d "${CGROUP_ROOT}" ] || break
  sleep 0.05
done

RESIDUE=0
if [ -d "${CGROUP_ROOT}" ]; then
  leftover_groups="$(find "${CGROUP_ROOT}" -maxdepth 1 -type d -name 'dolly-module-*' 2>/dev/null | wc -l | tr -d ' ')"
  leftover_processes="$(cat "${CGROUP_ROOT}"/cgroup.procs "${CGROUP_ROOT}"/*/cgroup.procs 2>/dev/null | wc -l | tr -d ' ')"
  observe "after cleanup: ${CGROUP_ROOT} still exists with ${leftover_groups} Module control group(s) and ${leftover_processes} process(es)"
  if [ "${leftover_groups}" != "0" ] || [ "${leftover_processes}" != "0" ]; then RESIDUE=1; fi
else
  observe "after cleanup: the delegated service root ${CGROUP_ROOT} and every Module control group below it are gone"
fi
if systemctl "${SYSTEMCTL_SCOPE}" list-units --all --no-legend --plain "${UNIT_PREFIX}${CASE_ID#LC-}.service" 2>/dev/null | grep -q .; then
  observe "after cleanup: the unit is still loaded"
  RESIDUE=1
else
  observe "after cleanup: the unit is no longer loaded"
fi

cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
for durable in core-state.json result-commit-journal.json declared-environment.json; do
  [ -e "${STANDIN_STATE}/${durable}" ] || continue
  cp "${STANDIN_STATE}/${durable}" "${SNAPSHOTS}/final-${durable}" 2>/dev/null || true
done
{
  printf 'case %s\nreason %s\nmembership %s\ndescendant %s\n' \
    "${CASE_ID}" "${REASON}" "${MEMBERSHIP}" "${DESCENDANT}"
  printf 'first-invocation %s\nlast-invocation %s\nrestarts %s\n' \
    "${FIRST_INVOCATION_ID}" "${LAST_INVOCATION_ID}" "${RESTARTS}"
} >"${SNAPSHOTS}/index"

# ---------------------------------------------------------------------------
# Evaluate
# ---------------------------------------------------------------------------

node "${EVALUATOR}" \
  --case "${CASE_ID}" \
  --reason "${REASON}" \
  --membership "${MEMBERSHIP}" \
  --descendant "${DESCENDANT}" \
  --report "${REPORT}" \
  --trace "${BARRIER_DIR}/trace-1" \
  --first-invocation-id "${FIRST_INVOCATION_ID}" \
  --last-invocation-id "${LAST_INVOCATION_ID}" \
  --restarts "${RESTARTS}" \
  --residue "${RESIDUE}" \
  --output "${CASE_DIR}/invariant-evaluation.json" \
  >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}"
evaluation_exit=$?

rm -rf "${WORK_DIR}"

case "${evaluation_exit}" in
  0) finish passed "core-survived-and-proved-module-cleanup-${REASON}-${MEMBERSHIP}-membership" ;;
  1) finish failed "invariant-violated-${REASON}-${MEMBERSHIP}-membership" ;;
  # The Extension is executed only after Core verifies control-group membership,
  # so it cannot have forked a descendant before that point. The evaluator
  # reports this only after confirming from the run's own trace that execution
  # was never authorized; it is never asserted from the case name alone.
  3) finish not-applicable "extension-cannot-fork-a-descendant-before-execution-is-authorized" ;;
  *) finish inconclusive invariant-evaluation-did-not-complete ;;
esac
