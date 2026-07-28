#!/bin/bash
# Case handler: the fixed interruption matrix.
#
# One case terminates the Core service at exactly one of the fourteen durable
# boundaries protocol version 3 enumerates, immediately before or immediately
# after that boundary, with one of seven workloads, and then requires the
# restarted Core to reconcile what the interrupted one left behind.
#
# What runs is not a test process that resembles Core. It is
# `core-standin/core-standin.mts`, which composes the shipped Core parts (the
# Core-state store, the ordered Module process lifecycle, the reviewed child
# launcher, the Module control group, the capability authority, the result
# commit journal, and startup recovery) and runs as the main process of a
# stable systemd service configured exactly as ADR 0009 requires. The
# interruption is a real `SIGKILL` to that main process, and the recovery is the
# service manager's own restart path.
#
# The interruption point is confirmed, never guessed. The stand-in writes an
# arrival file at the named boundary and then stops its only thread on a value
# nothing ever changes, so when this handler sees the file it knows Core is at
# that point and has performed nothing after it. See `core-standin/barrier.mts`.
#
# What a pass from this handler means, and what it does not: the stand-in speaks
# this experiment's own Extension protocol rather than `ExtensionProcessHost`.
# When the matrix ran that was forced — the host could only spawn its own direct
# child, so the composition ADR 0009 requires could not be assembled at all. The
# host has since gained an attached-process seam, and the stand-in is due to be
# reworked onto it. Until that rework and its rerun, a pass here is evidence
# about the durability and ownership boundary design, not evidence that ADR 0009
# can be delivered on the code as it stands.
# `docs/experiments/linux-core-service-ownership-results.md` states the limit in
# full; do not quote these results without it.
#
# Case identifier: FM-<boundary>-<before|after>-<workload>-proposed
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

# Removes exactly what this case created: its own unit, its own unit file, and
# its own scratch state. Nothing here is taken from case output, and every name
# was constructed by this handler from the run's reserved prefix.
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

if [[ ! "${CASE_ID}" =~ ^FM-(M[0-9]{2}(\.[a-z]+)?)-(before|after)-(.+)-proposed$ ]]; then
  finish inconclusive unrecognised-case-identifier
fi
BOUNDARY="${BASH_REMATCH[1]}"
TIMING="${BASH_REMATCH[3]}"
WORKLOAD="${BASH_REMATCH[4]}"

if [ "${SYSTEMCTL_SCOPE}" != "--user" ]; then
  finish inconclusive this-handler-implements-only-the-user-service-scope
fi

EXPERIMENT_DIR="${REPOSITORY}/scripts/experiments/linux-core-service-ownership"
STANDIN="${EXPERIMENT_DIR}/core-standin/core-standin.mts"
FIXTURE="${EXPERIMENT_DIR}/core-standin/extension-fixture.py"
LAUNCHER="${REPOSITORY}/src/adapters/linux-module-launcher/launcher.py"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVALUATOR="${EXPERIMENT_DIR}/handlers/fixed-interruption-evaluate.mjs"

NODE_PROGRAM="$(command -v node 2>/dev/null || true)"
PYTHON_PROGRAM="$(command -v python3 2>/dev/null || true)"

for required in "${STANDIN}" "${FIXTURE}" "${LAUNCHER}" "${TSX_LOADER}" "${EVALUATOR}"; do
  [ -f "${required}" ] || finish inconclusive "required-file-missing"
done
[ -n "${NODE_PROGRAM}" ] || finish inconclusive node-not-found
[ -n "${PYTHON_PROGRAM}" ] || finish inconclusive python3-not-found

# The Core service command must be one absolute installed path with no text
# systemd or a shell would interpret; `linux-core-service-binding.ts` checks
# this and refuses the service otherwise. A relative or decorated interpreter
# path here would make every case fail for the wrong reason, so it is rejected
# up front with a reason that says so.
case "${NODE_PROGRAM}" in
  /*) ;;
  *) finish inconclusive node-path-is-not-absolute ;;
esac

# ---------------------------------------------------------------------------
# The service under test
# ---------------------------------------------------------------------------

UNIT="${UNIT_PREFIX}${CASE_ID#FM-}.service"
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

# The configuration is written with Node rather than by string interpolation so
# every path is JSON-encoded exactly once.
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
  boundary "${BOUNDARY}" \
  timing "${TIMING}" \
  workload "${WORKLOAD}" \
  instanceId "dolly-test-instance" \
  moduleId "experimentworker" \
  moduleGenerationId "dolly-test-module-generation-1" \
  interpreterProgram "${PYTHON_PROGRAM}" \
  launcherScriptPath "${LAUNCHER}" \
  extensionFixturePath "${FIXTURE}" \
  || finish inconclusive could-not-write-standin-configuration

# Every effective setting `verifyCoreServiceBinding` requires, written
# explicitly so a case can never pass against a service that was not the
# configuration under test. `ExecStart` uses the systemd ":" prefix, which the
# manager reports as the `no-env-expand` flag.
cat >"${UNIT_FILE}" <<UNITFILE
[Unit]
Description=Dolly fixed interruption matrix Core stand-in (${CASE_ID})
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

event "starting ${UNIT} for boundary ${BOUNDARY} ${TIMING} with workload ${WORKLOAD}"
if ! systemctl "${SYSTEMCTL_SCOPE}" start "${UNIT}" >"${CASE_DIR}/systemctl-start.log" 2>&1; then
  cp "${CASE_DIR}/systemctl-start.log" "${SNAPSHOTS}/systemctl-start.log" 2>/dev/null || true
  finish inconclusive core-service-would-not-start
fi

FIRST_INVOCATION_ID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p InvocationID --value 2>/dev/null)"
CONTROL_GROUP="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p ControlGroup --value 2>/dev/null)"
event "unit started invocation=${FIRST_INVOCATION_ID} cgroup=${CONTROL_GROUP}"

# ---------------------------------------------------------------------------
# Wait for the barrier, deterministically
# ---------------------------------------------------------------------------

ARRIVAL="${BARRIER_DIR}/arrived"
REPORT_ONE="${BARRIER_DIR}/report-1.json"
REPORT_TWO="${BARRIER_DIR}/report-2.json"

# 90 seconds at 50 milliseconds. The wait ends as soon as the arrival file
# exists or the service leaves the active state; it never sleeps a fixed
# interval and then assumes anything.
arrived="no"
finished_early="no"
for _ in $(seq 1 1800); do
  if [ -f "${ARRIVAL}" ]; then arrived="yes"; break; fi
  if [ -f "${REPORT_ONE}" ]; then finished_early="yes"; break; fi
  if ! systemctl "${SYSTEMCTL_SCOPE}" is-active --quiet "${UNIT}" 2>/dev/null; then
    # The service left the active state without reaching the barrier. One more
    # look for a report it may have written on its way out.
    sleep 0.2
    if [ -f "${ARRIVAL}" ]; then arrived="yes"; fi
    if [ -f "${REPORT_ONE}" ]; then finished_early="yes"; fi
    break
  fi
  sleep 0.05
done

if [ "${arrived}" != "yes" ]; then
  cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
  journalctl "${SYSTEMCTL_SCOPE}" -u "${UNIT}" --no-pager -n 200 \
    >"${SNAPSHOTS}/journal.txt" 2>/dev/null || true
  observe "the stand-in never reached barrier ${BOUNDARY}-${TIMING}"
  if [ "${finished_early}" = "yes" ]; then
    phase="$(node -e '
      const fs = require("node:fs");
      try {
        console.log(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).phase ?? "unknown"));
      } catch { console.log("unreadable"); }
    ' "${REPORT_ONE}")"
    observe "invocation 1 finished in phase ${phase}"
    teardown
    # Two boundaries do not exist for one workload: a Run with no output
    # commits no Block and appends no output Delivery, so boundaries 11 and 12
    # never happen in it. The protocol's matrix is a cross product and
    # enumerates the combination anyway. It is reported as not applicable, with
    # the reason, rather than as a pass it did not earn or a failure of an
    # implementation that behaved correctly.
    if [ "${phase}" = "completed-without-interruption" ] && [ "${WORKLOAD}" = "no-output" ] \
        && { [ "${BOUNDARY}" = "M11" ] || [ "${BOUNDARY}" = "M12" ]; }; then
      observe "boundary ${BOUNDARY} does not occur in a Run with no output"
      finish not-applicable "boundary-${BOUNDARY}-does-not-occur-without-output"
    fi
    case "${phase}" in
      activation-refused) finish inconclusive core-service-binding-not-provable-in-this-environment ;;
      *) finish failed "barrier-not-reached-phase-${phase}" ;;
    esac
  fi
  teardown
  finish inconclusive barrier-not-reached-before-deadline
fi

event "barrier ${BOUNDARY}-${TIMING} reached"

# ---------------------------------------------------------------------------
# Snapshot everything durable at the barrier, then terminate Core
# ---------------------------------------------------------------------------

MAIN_PID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p MainPID --value 2>/dev/null)"
systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" \
  -p MainPID -p InvocationID -p ControlGroup -p ActiveState -p SubState \
  -p NRestarts -p Type -p Restart -p KillMode -p SendSIGKILL -p Delegate \
  -p DelegateSubgroup -p ExitType -p RestartMode -p RemainAfterExit \
  -p TimeoutStopUSec -p ExecStartEx \
  >"${SNAPSHOTS}/unit-properties-at-barrier" 2>/dev/null || true

cp "${ARRIVAL}" "${SNAPSHOTS}/arrival" 2>/dev/null || true
for durable in core-state.json result-commit-journal.json capability-effect-journal \
    extension-result-receipts external-effects declared-environment.json \
    extension-environment.json extension-environment.json.runtime invocation-count.json; do
  [ -e "${STANDIN_STATE}/${durable}" ] || continue
  cp "${STANDIN_STATE}/${durable}" "${SNAPSHOTS}/at-barrier-${durable}" 2>/dev/null || true
done

CGROUP_ROOT="/sys/fs/cgroup${CONTROL_GROUP}"
MODULE_CGROUPS_AT_BARRIER="${CASE_DIR}/module-cgroups-at-barrier"
: >"${MODULE_CGROUPS_AT_BARRIER}"
if [ -d "${CGROUP_ROOT}" ]; then
  find "${CGROUP_ROOT}" -maxdepth 1 -type d -name 'dolly-module-*' \
    >"${MODULE_CGROUPS_AT_BARRIER}" 2>/dev/null || true
fi

observe "at barrier: unit ${UNIT} main process ${MAIN_PID}"
observe "at barrier: delegated root ${CGROUP_ROOT}"
observe "at barrier: core cgroup members $(tr '\n' ' ' <"${CGROUP_ROOT}/core/cgroup.procs" 2>/dev/null)"
while IFS= read -r module_cgroup; do
  [ -n "${module_cgroup}" ] || continue
  name="$(basename "${module_cgroup}")"
  mkdir -p "${SNAPSHOTS}/cgroups/${name}"
  for control in cgroup.procs cgroup.events cgroup.controllers memory.max pids.max cpu.max; do
    [ -r "${module_cgroup}/${control}" ] || continue
    cp "${module_cgroup}/${control}" "${SNAPSHOTS}/cgroups/${name}/${control}" 2>/dev/null || true
  done
  observe "at barrier: module cgroup ${name}"
  observe "  members $(tr '\n' ' ' <"${module_cgroup}/cgroup.procs" 2>/dev/null)"
  observe "  memory.max $(cat "${module_cgroup}/memory.max" 2>/dev/null) pids.max $(cat "${module_cgroup}/pids.max" 2>/dev/null) cpu.max $(cat "${module_cgroup}/cpu.max" 2>/dev/null)"
  observe "  $(cat "${module_cgroup}/cgroup.events" 2>/dev/null | tr '\n' ' ')"
done <"${MODULE_CGROUPS_AT_BARRIER}"

if [ -z "${MAIN_PID}" ] || [ "${MAIN_PID}" = "0" ]; then
  teardown
  finish inconclusive service-manager-reported-no-main-process
fi

# The signal goes to the process the service manager currently reports as the
# unit's main process, which is the live Core. No process identifier is ever
# read back from a durable record and signalled; INV-07 is about exactly that.
event "sending SIGKILL to the service main process ${MAIN_PID}"
observe "signal: SIGKILL to service-manager-reported main process ${MAIN_PID} (never a recovered identifier)"
kill -KILL "${MAIN_PID}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Wait for the service manager's own restart and the recovery report
# ---------------------------------------------------------------------------

# The restart evidence has to be read while the restarted invocation is still
# active: once it exits, the service manager clears `InvocationID` and
# `NRestarts` for the inactive unit, and a later reading would show nothing.
SECOND_INVOCATION_ID=""
RESTARTS="0"
for _ in $(seq 1 1200); do
  current="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p InvocationID --value 2>/dev/null)"
  if [ -n "${current}" ] && [ "${current}" != "${FIRST_INVOCATION_ID}" ]; then
    SECOND_INVOCATION_ID="${current}"
    RESTARTS="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p NRestarts --value 2>/dev/null)"
    break
  fi
  [ -f "${REPORT_TWO}" ] && break
  sleep 0.02
done

recovered="no"
for _ in $(seq 1 1200); do
  if [ -f "${REPORT_TWO}" ]; then recovered="yes"; break; fi
  sleep 0.05
done
event "after termination: restarts=${RESTARTS} invocation=${SECOND_INVOCATION_ID} recovered=${recovered}"
observe "after termination: NRestarts=${RESTARTS} first invocation ${FIRST_INVOCATION_ID} second invocation ${SECOND_INVOCATION_ID}"

journalctl "${SYSTEMCTL_SCOPE}" -u "${UNIT}" --no-pager -n 400 \
  >"${SNAPSHOTS}/journal.txt" 2>/dev/null || true

if [ "${recovered}" != "yes" ]; then
  cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
  teardown
  finish failed core-service-did-not-produce-a-recovery-report-after-restart
fi

# ---------------------------------------------------------------------------
# Stop the service and prove this case left nothing behind
# ---------------------------------------------------------------------------

teardown
UNIT=""

# Stopping the unit makes the service manager remove the whole unit control
# group, Module control groups included. It is not instantaneous, so the check
# waits for it rather than reading a race as residue.
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
if systemctl "${SYSTEMCTL_SCOPE}" list-units --all --no-legend --plain "${UNIT_PREFIX}${CASE_ID#FM-}.service" 2>/dev/null | grep -q .; then
  observe "after cleanup: the unit is still loaded"
  RESIDUE=1
else
  observe "after cleanup: the unit is no longer loaded"
fi

# Retain the reports and traces as the case's own evidence.
cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
for durable in core-state.json result-commit-journal.json capability-effect-journal \
    extension-result-receipts external-effects declared-environment.json \
    extension-environment.json; do
  [ -e "${STANDIN_STATE}/${durable}" ] || continue
  cp "${STANDIN_STATE}/${durable}" "${SNAPSHOTS}/final-${durable}" 2>/dev/null || true
done
{
  printf 'case %s\nboundary %s\ntiming %s\nworkload %s\n' \
    "${CASE_ID}" "${BOUNDARY}" "${TIMING}" "${WORKLOAD}"
  printf 'first-invocation %s\nsecond-invocation %s\nrestarts %s\n' \
    "${FIRST_INVOCATION_ID}" "${SECOND_INVOCATION_ID}" "${RESTARTS}"
} >"${SNAPSHOTS}/index"
[ -f "${BARRIER_DIR}/trace-1" ] && cat "${BARRIER_DIR}/trace-1" >>"${EVENTS}"
[ -f "${BARRIER_DIR}/trace-2" ] && cat "${BARRIER_DIR}/trace-2" >>"${EVENTS}"

# ---------------------------------------------------------------------------
# Evaluate the twelve invariants
# ---------------------------------------------------------------------------

node "${EVALUATOR}" \
  --case "${CASE_ID}" \
  --boundary "${BOUNDARY}" \
  --timing "${TIMING}" \
  --workload "${WORKLOAD}" \
  --report-two "${REPORT_TWO}" \
  --trace-one "${BARRIER_DIR}/trace-1" \
  --trace-two "${BARRIER_DIR}/trace-2" \
  --arrival "${ARRIVAL}" \
  --module-cgroups-at-barrier "${MODULE_CGROUPS_AT_BARRIER}" \
  --cgroup-snapshot-dir "${SNAPSHOTS}/cgroups" \
  --declared-environment "${STANDIN_STATE}/declared-environment.json" \
  --observed-environment "${STANDIN_STATE}/extension-environment.json" \
  --first-invocation-id "${FIRST_INVOCATION_ID}" \
  --second-invocation-id "${SECOND_INVOCATION_ID}" \
  --restarts "${RESTARTS}" \
  --residue "${RESIDUE}" \
  --output "${CASE_DIR}/invariant-evaluation.json" \
  >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}"
evaluation_exit=$?

rm -rf "${WORK_DIR}"

case "${evaluation_exit}" in
  0) finish passed "interrupted-at-${BOUNDARY}-${TIMING}-and-recovered" ;;
  1) finish failed "invariant-violated-at-${BOUNDARY}-${TIMING}" ;;
  *) finish inconclusive invariant-evaluation-did-not-complete ;;
esac
