#!/bin/bash
# Case handler: capability idempotency evidence across a Core crash.
#
# ADR 0009 refuses to accept an in-memory duplicate map as restart evidence. The
# seven cases here interrupt Core around one capability invocation that has a
# real external effect, and ask what the restarted Core can honestly conclude
# from what survived on disk.
#
# The two durable moments are the ones protocol version 3 calls boundary 8:
#
#   M08.start       the effect intent becomes durable before the handler can
#                   cause any effect
#   M08.completion  the outcome becomes durable after the effect is known
#
# Killing Core immediately after the first leaves an intent and no effect;
# killing it immediately before the second leaves an effect and no outcome.
# Those are exactly "before the remote operation is accepted" and "after the
# remote operation is accepted", and the second is indistinguishable on disk
# from "the remote response was lost" — which is the point. A Core that cannot
# tell them apart must query the outcome, never silently retry it.
#
# This handler adds no subprocess protocol of its own: it drives the shared
# `core-standin/core-standin.mts` at existing boundaries with the existing
# `unknown-external-effect` workload, and only the evaluation differs.
#
# Case identifier: SC-09-0N-<name>
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

event() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" >>"${EVENTS}"; }
observe() { printf '%s\n' "$1" >>"${OBSERVATIONS}"; }

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
# Case identity: which durable moment this case interrupts
# ---------------------------------------------------------------------------

case "${CASE_ID}" in
  # An intent written before any effect must still be there after the crash.
  SC-09-01-effect-intent-survives-crash)      BOUNDARY="M08.start";      TIMING="after"  ;;
  # The same record must still name the exact Claim and Run it belonged to.
  SC-09-02-idempotency-key-linked-to-claim)   BOUNDARY="M08.start";      TIMING="after"  ;;
  # The authority's in-memory map is gone; only the journal may decide.
  SC-09-03-in-memory-duplicate-map-rejected)  BOUNDARY="M08.completion"; TIMING="before" ;;
  # An unresolved invocation must be queried, never automatically retried.
  SC-09-04-unknown-outcome-queried-not-retried) BOUNDARY="M08.completion"; TIMING="before" ;;
  # Crash before the remote operation is accepted: intent, no effect.
  SC-09-05-crash-before-remote-acceptance)    BOUNDARY="M08.start";      TIMING="after"  ;;
  # Crash after it is accepted: effect performed, outcome not durable.
  SC-09-06-crash-after-remote-acceptance)     BOUNDARY="M08.completion"; TIMING="before" ;;
  # Crash after the response is lost: deliberately the same durable evidence
  # as the previous case, which is what makes "query, do not retry" necessary.
  SC-09-07-crash-after-lost-response)         BOUNDARY="M08.completion"; TIMING="before" ;;
  *) finish inconclusive unrecognised-case-identifier ;;
esac
WORKLOAD="unknown-external-effect"

if [ "${SYSTEMCTL_SCOPE}" != "--user" ]; then
  finish inconclusive this-handler-implements-only-the-user-service-scope
fi

EXPERIMENT_DIR="${REPOSITORY}/scripts/experiments/linux-core-service-ownership"
STANDIN="${EXPERIMENT_DIR}/core-standin/core-standin.mts"
FIXTURE="${EXPERIMENT_DIR}/core-standin/extension-fixture.py"
LAUNCHER="${REPOSITORY}/src/adapters/linux-module-launcher/launcher.py"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVALUATOR="${EXPERIMENT_DIR}/handlers/capability-idempotency-evaluate.mjs"

NODE_PROGRAM="$(command -v node 2>/dev/null || true)"
PYTHON_PROGRAM="$(command -v python3 2>/dev/null || true)"
# The reason names the missing file, for the reason given in
# `live-core-termination.sh`: a bare code leaves five candidate paths to guess.
for required in "${STANDIN}" "${FIXTURE}" "${LAUNCHER}" "${TSX_LOADER}" "${EVALUATOR}"; do
  [ -f "${required}" ] || finish inconclusive "required-file-missing-$(basename "${required}")"
done
[ -n "${NODE_PROGRAM}" ] || finish inconclusive node-not-found
[ -n "${PYTHON_PROGRAM}" ] || finish inconclusive python3-not-found
case "${NODE_PROGRAM}" in /*) ;; *) finish inconclusive node-path-is-not-absolute ;; esac

# ---------------------------------------------------------------------------
# The service under test
# ---------------------------------------------------------------------------

UNIT="${UNIT_PREFIX}${CASE_ID#SC-}.service"
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
  caseId "${CASE_ID}" unitName "${UNIT}" serviceMode user \
  stateDirectory "${STANDIN_STATE}" barrierDirectory "${BARRIER_DIR}" \
  boundary "${BOUNDARY}" timing "${TIMING}" workload "${WORKLOAD}" \
  instanceId "dolly-test-instance" moduleId "experimentworker" \
  moduleGenerationId "dolly-test-module-generation-1" \
  interpreterProgram "${PYTHON_PROGRAM}" launcherScriptPath "${LAUNCHER}" \
  extensionFixturePath "${FIXTURE}" \
  || finish inconclusive could-not-write-standin-configuration

cat >"${UNIT_FILE}" <<UNITFILE
[Unit]
Description=Dolly capability idempotency Core stand-in (${CASE_ID})
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

event "starting ${UNIT} at ${BOUNDARY}-${TIMING} with ${WORKLOAD}"
if ! systemctl "${SYSTEMCTL_SCOPE}" start "${UNIT}" >"${CASE_DIR}/systemctl-start.log" 2>&1; then
  cp "${CASE_DIR}/systemctl-start.log" "${SNAPSHOTS}/systemctl-start.log" 2>/dev/null || true
  finish inconclusive core-service-would-not-start
fi

FIRST_INVOCATION_ID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p InvocationID --value 2>/dev/null)"
CONTROL_GROUP="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p ControlGroup --value 2>/dev/null)"
event "unit started invocation=${FIRST_INVOCATION_ID} cgroup=${CONTROL_GROUP}"

# ---------------------------------------------------------------------------
# Wait for the barrier, deterministically, then snapshot and terminate
# ---------------------------------------------------------------------------

ARRIVAL="${BARRIER_DIR}/arrived"
REPORT_ONE="${BARRIER_DIR}/report-1.json"
REPORT_TWO="${BARRIER_DIR}/report-2.json"

arrived="no"
finished_early="no"
for _ in $(seq 1 1800); do
  if [ -f "${ARRIVAL}" ]; then arrived="yes"; break; fi
  if [ -f "${REPORT_ONE}" ]; then finished_early="yes"; break; fi
  if ! systemctl "${SYSTEMCTL_SCOPE}" is-active --quiet "${UNIT}" 2>/dev/null; then
    sleep 0.2
    [ -f "${ARRIVAL}" ] && arrived="yes"
    [ -f "${REPORT_ONE}" ] && finished_early="yes"
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
      try { console.log(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).phase ?? "unknown")); }
      catch { console.log("unreadable"); }
    ' "${REPORT_ONE}")"
    observe "invocation 1 finished in phase ${phase}"
    teardown
    case "${phase}" in
      activation-refused) finish inconclusive core-service-binding-not-provable-in-this-environment ;;
      *) finish failed "barrier-not-reached-phase-${phase}" ;;
    esac
  fi
  teardown
  finish inconclusive barrier-not-reached-before-deadline
fi

event "barrier ${BOUNDARY}-${TIMING} reached"

# The durable state at the instant of the crash. This is the evidence the
# restarted Core is entitled to use, and nothing else.
cp "${ARRIVAL}" "${SNAPSHOTS}/arrival" 2>/dev/null || true
for durable in core-state.json result-commit-journal.json capability-effect-journal \
    extension-result-receipts external-effects; do
  [ -e "${STANDIN_STATE}/${durable}" ] || continue
  cp "${STANDIN_STATE}/${durable}" "${SNAPSHOTS}/at-barrier-${durable}" 2>/dev/null || true
done

MAIN_PID="$(systemctl "${SYSTEMCTL_SCOPE}" show "${UNIT}" -p MainPID --value 2>/dev/null)"
if [ -z "${MAIN_PID}" ] || [ "${MAIN_PID}" = "0" ]; then
  teardown
  finish inconclusive service-manager-reported-no-main-process
fi
event "sending SIGKILL to the service main process ${MAIN_PID}"
observe "signal: SIGKILL to service-manager-reported main process ${MAIN_PID} (never a recovered identifier)"
kill -KILL "${MAIN_PID}" 2>/dev/null || true

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

journalctl "${SYSTEMCTL_SCOPE}" -u "${UNIT}" --no-pager -n 400 \
  >"${SNAPSHOTS}/journal.txt" 2>/dev/null || true

if [ "${recovered}" != "yes" ]; then
  cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
  teardown
  finish failed core-service-did-not-produce-a-recovery-report-after-restart
fi

# ---------------------------------------------------------------------------
# Clean up and prove no residue
# ---------------------------------------------------------------------------

CGROUP_ROOT="/sys/fs/cgroup${CONTROL_GROUP}"
teardown
UNIT=""
for _ in $(seq 1 60); do [ -d "${CGROUP_ROOT}" ] || break; sleep 0.05; done

RESIDUE=0
if [ -d "${CGROUP_ROOT}" ]; then
  leftover_groups="$(find "${CGROUP_ROOT}" -maxdepth 1 -type d -name 'dolly-module-*' 2>/dev/null | wc -l | tr -d ' ')"
  leftover_processes="$(cat "${CGROUP_ROOT}"/cgroup.procs "${CGROUP_ROOT}"/*/cgroup.procs 2>/dev/null | wc -l | tr -d ' ')"
  observe "after cleanup: ${CGROUP_ROOT} still exists with ${leftover_groups} group(s) and ${leftover_processes} process(es)"
  if [ "${leftover_groups}" != "0" ] || [ "${leftover_processes}" != "0" ]; then RESIDUE=1; fi
else
  observe "after cleanup: the delegated service root and every Module control group below it are gone"
fi
if systemctl "${SYSTEMCTL_SCOPE}" list-units --all --no-legend --plain "${UNIT_PREFIX}${CASE_ID#SC-}.service" 2>/dev/null | grep -q .; then
  observe "after cleanup: the unit is still loaded"; RESIDUE=1
else
  observe "after cleanup: the unit is no longer loaded"
fi

cp -r "${BARRIER_DIR}/." "${SNAPSHOTS}/" 2>/dev/null || true
for durable in capability-effect-journal external-effects core-state.json; do
  [ -e "${STANDIN_STATE}/${durable}" ] || continue
  cp "${STANDIN_STATE}/${durable}" "${SNAPSHOTS}/final-${durable}" 2>/dev/null || true
done
[ -f "${BARRIER_DIR}/trace-1" ] && cat "${BARRIER_DIR}/trace-1" >>"${EVENTS}"
[ -f "${BARRIER_DIR}/trace-2" ] && cat "${BARRIER_DIR}/trace-2" >>"${EVENTS}"

node "${EVALUATOR}" \
  --case "${CASE_ID}" \
  --boundary "${BOUNDARY}" \
  --timing "${TIMING}" \
  --report-two "${REPORT_TWO}" \
  --journal-at-barrier "${SNAPSHOTS}/at-barrier-capability-effect-journal" \
  --effects-at-barrier "${SNAPSHOTS}/at-barrier-external-effects" \
  --journal-final "${SNAPSHOTS}/final-capability-effect-journal" \
  --effects-final "${SNAPSHOTS}/final-external-effects" \
  --first-invocation-id "${FIRST_INVOCATION_ID}" \
  --second-invocation-id "${SECOND_INVOCATION_ID}" \
  --restarts "${RESTARTS}" \
  --residue "${RESIDUE}" \
  --output "${CASE_DIR}/invariant-evaluation.json" \
  >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}"
evaluation_exit=$?

rm -rf "${WORK_DIR}"

case "${evaluation_exit}" in
  0) finish passed "idempotency-evidence-survived-and-was-used-honestly-at-${BOUNDARY}-${TIMING}" ;;
  1) finish failed "invariant-violated-at-${BOUNDARY}-${TIMING}" ;;
  *) finish inconclusive invariant-evaluation-did-not-complete ;;
esac
