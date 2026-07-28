#!/bin/bash
# Case handler: Core service binding verification.
#
# Architecture Decision Record 0009 requires Core to prove both directions of
# its service binding before it accepts Module work: the service manager
# reports this process as the unit's main process, and this process's own
# control group is the unit's delegated subgroup. This handler runs the real
# verifier from `src/core/linux-core-service-binding.ts` and requires each case
# to reach the exact refusal the protocol expects.
#
# Cases:
#   SC-01-01-no-service            no service at all, so nothing can be proven
#   SC-01-02-manager-pid-mismatch  a live unit whose main process is not this one
#   SC-01-03-cgroup-path-mismatch  a service without the required delegated subgroup
#
# The handler writes every artifact the catalog requires. A case whose expected
# refusal does not appear is reported `failed`, not quietly skipped.
set -uo pipefail

CASE_ID="${DOLLY_EXPERIMENT_CASE_ID:?}"
CASE_DIR="${DOLLY_EXPERIMENT_CASE_DIR:?}"
REPOSITORY="${DOLLY_EXPERIMENT_REPOSITORY:?}"
UNIT_PREFIX="${DOLLY_EXPERIMENT_UNIT_PREFIX:?}"
UNIT_LEDGER="${DOLLY_EXPERIMENT_UNIT_LEDGER:?}"

# shellcheck source=../lib/safety.sh
. "${REPOSITORY}/scripts/experiments/linux-core-service-ownership/lib/safety.sh"

PROBE="${REPOSITORY}/tests/conformance/core/fixtures/core-service-binding-probe.ts"
TSX_LOADER="${REPOSITORY}/node_modules/tsx/dist/loader.mjs"
EVENTS="${CASE_DIR}/events"
OBSERVATIONS="${CASE_DIR}/process-and-cgroup-observations"
OUTCOME="${CASE_DIR}/case-outcome"

: >"${EVENTS}"
: >"${OBSERVATIONS}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${EVENTS}"
}

# Writes the outcome and exits. Every exit path goes through here so the case
# always has a readable status rather than defaulting to unreadable.
finish() {
  local status="$1" reason="$2"
  printf 'status=%s\nreason=%s\n' "${status}" "${reason}" >"${OUTCOME}"
  event "outcome ${status} ${reason}"
  [ "${status}" = "passed" ] && exit 0
  exit 0
}

[ -f "${PROBE}" ] || finish inconclusive binding-probe-missing
[ -f "${TSX_LOADER}" ] || finish inconclusive tsx-loader-missing

stop_unit() {
  systemctl --user stop "$1" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1" >/dev/null 2>&1 || true
}

# Runs the probe in the current process. `tsx` is imported rather than used as
# a command because its command-line interface re-executes the script in a
# child process, which would compare the wrong process identifier against the
# one the service manager reports.
run_probe() {
  node --import "file://${TSX_LOADER}" "${PROBE}" "$1" user
}

# Reads the probe's single JSON result line and asserts the required failure
# codes are present. Prints the observed codes so the artifact records them.
assert_codes() {
  local file="$1"
  shift
  node -e '
    const fs = require("node:fs");
    const [file, ...required] = process.argv.slice(1);
    const line = fs.readFileSync(file, "utf8").split("\n").reverse()
      .find((l) => l.trim().startsWith("{"));
    if (!line) { console.error("no-result-line"); process.exit(2); }
    const out = JSON.parse(line);
    const codes = out.observed === false
      ? (out.failures ?? []).map((f) => f.code)
      : (out.result?.verified ? [] : (out.result?.failures ?? []).map((f) => f.code));
    console.log("observed=" + (codes.join(",") || "none"));
    const missing = required.filter((code) => !codes.includes(code));
    if (missing.length > 0) { console.error("missing=" + missing.join(",")); process.exit(1); }
  ' "${file}" "$@"
}

case "${CASE_ID}" in
  SC-01-01-no-service)
    # The reserved prefix belongs to this run and nothing created this unit, so
    # verification must fail closed rather than assume a service exists.
    unit="${UNIT_PREFIX}absent.service"
    event "probing absent unit ${unit}"
    run_probe "${unit}" >"${CASE_DIR}/binding-observation.json" 2>"${CASE_DIR}/probe.stderr"
    assert_codes "${CASE_DIR}/binding-observation.json" \
      CORE_SERVICE_UNIT_NOT_FOUND >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
      || finish failed expected-unit-not-found-refusal
    finish passed refused-absent-service
    ;;

  SC-01-02-manager-pid-mismatch)
    # A live unit whose main process is a sleep, with the probe running outside
    # it. Both directions of the binding must fail.
    unit="${UNIT_PREFIX}pidmismatch"
    dolly_ledger_add_unit "${UNIT_LEDGER}" "${unit}.service" || finish inconclusive unit-name-refused-by-ledger
    event "creating live unit ${unit}.service"
    if ! systemd-run --user --quiet "--unit=${unit}" \
        -p Type=exec -p Delegate=yes -p DelegateSubgroup=core \
        -- /bin/sleep 120 >/dev/null 2>&1; then
      finish inconclusive could-not-create-live-unit
    fi
    sleep 1
    run_probe "${unit}.service" >"${CASE_DIR}/binding-observation.json" 2>"${CASE_DIR}/probe.stderr"
    stop_unit "${unit}.service"
    event "stopped ${unit}.service"
    assert_codes "${CASE_DIR}/binding-observation.json" \
      CORE_SERVICE_MAIN_PID_MISMATCH CORE_SERVICE_CGROUP_MISMATCH \
      >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
      || finish failed expected-both-directions-refused
    finish passed refused-foreign-main-process
    ;;

  SC-01-03-cgroup-path-mismatch)
    # A service that delegates no `core` subgroup leaves its main process in
    # the delegated root itself, the topology ADR 0009 forbids because a parent
    # holding tasks cannot distribute controllers to siblings.
    unit="${UNIT_PREFIX}nosubgroup"
    dolly_ledger_add_unit "${UNIT_LEDGER}" "${unit}.service" || finish inconclusive unit-name-refused-by-ledger
    event "running probe inside ${unit}.service without a delegated subgroup"
    systemd-run --user --quiet --pipe --wait --collect "--unit=${unit}" \
      -p Type=exec -p Delegate=yes \
      -- node --import "file://${TSX_LOADER}" "${PROBE}" "${unit}.service" user \
      >"${CASE_DIR}/binding-observation.json" 2>"${CASE_DIR}/probe.stderr"
    assert_codes "${CASE_DIR}/binding-observation.json" \
      CORE_SERVICE_DELEGATE_SUBGROUP_INVALID \
      >>"${OBSERVATIONS}" 2>>"${OBSERVATIONS}" \
      || finish failed expected-delegate-subgroup-refusal
    finish passed refused-missing-delegated-subgroup
    ;;

  *)
    finish inconclusive unknown-case
    ;;
esac
