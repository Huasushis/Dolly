#!/bin/bash
# Runner skeleton for the preregistered experiment
# `docs/experiments/linux-core-service-process-ownership.md` (protocol version 3).
#
# What this script does today:
#   * checks that the environment can host the experiment at all;
#   * takes an inventory of the reserved `dolly-test-` namespace before the run;
#   * writes the manifest and the ordered case list the protocol requires;
#   * walks every enumerated case, running its handler when one exists and
#     recording `inconclusive` when it does not;
#   * takes a second inventory, cleans up only what it recorded, and proves the
#     reserved namespace is back to its starting state; and
#   * writes the machine-readable summary, including failed and inconclusive
#     cases, and exits non-zero unless the run met its declared criterion.
#
# What it does not do: no case is implemented yet. Every case is enumerated and
# reported as inconclusive with the reason `case-handler-not-implemented`. That
# is deliberate: the protocol treats a case without artifacts as inconclusive,
# never as passing, so an unimplemented matrix can never look like a result.
#
# See docs/experiments/linux-core-service-ownership-runbook.md for how to
# prepare an environment, which cases may run where, and how to read a failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
HANDLERS_DIR="${SCRIPT_DIR}/handlers"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

EXIT_FAILURE=1
EXIT_USAGE=2
EXIT_ENVIRONMENT=3
EXIT_INCOMPLETE=4

usage() {
  cat <<'USAGE'
Usage: run.sh [options]

  --mode smoke|full         smoke checks the harness only and expects every case
                            to be inconclusive; full is a real experiment run
                            (default: full)
  --profile NAME            default | ustc-non-disruptive
  --output-dir DIR          where artifacts are written
                            (default: <repository>/artifacts/experiments/...)
  --service-mode user|system  systemd scope to use (default: user)
  --core-unit NAME          installed Core service unit whose effective
                            configuration is recorded in the manifest
  --seed N                  run seed (default: 1)
  --group ID                only run this case group (repeatable)
  --arm ID                  only run this arm (repeatable)
  --id-prefix PREFIX        only run cases whose identifier starts with PREFIX
  --exclude-id ID           drop this exact case from the selection (repeatable).
                            Use it to run a whole group without a case that must
                            run on its own. Every run records what it excluded,
                            so an excluded run is never a complete one.
  --non-disruptive-only     drop every case marked disruptive
  --disposable              assert this machine is disposable; required before
                            any disruptive case may run
  --allow-preexisting       continue even if the reserved dolly-test- namespace
                            is not empty before the run
  --list                    print the selected cases and exit
  --dry-run                 do everything except run case handlers
  -h, --help                print this message

Exit codes: 0 success, 1 failure, 2 usage error, 3 environment unmet,
4 run incomplete (inconclusive cases remain).
USAGE
}

MODE="full"
PROFILE="default"
OUTPUT_DIR=""
SERVICE_MODE="user"
CORE_UNIT=""
SEED="1"
LIST_ONLY="no"
DRY_RUN="no"
DISPOSABLE="no"
ALLOW_PREEXISTING="no"
NON_DISRUPTIVE_ONLY="no"
FILTER_ARGUMENTS=()
EXCLUDED_REQUESTED=()

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --service-mode) SERVICE_MODE="${2:-}"; shift 2 ;;
    --core-unit) CORE_UNIT="${2:-}"; shift 2 ;;
    --seed) SEED="${2:-}"; shift 2 ;;
    --exclude-id) FILTER_ARGUMENTS+=("--exclude-id" "${2:-}"); EXCLUDED_REQUESTED+=("${2:-}"); shift 2 ;;
    --group) FILTER_ARGUMENTS+=("--group" "${2:-}"); shift 2 ;;
    --arm) FILTER_ARGUMENTS+=("--arm" "${2:-}"); shift 2 ;;
    --id-prefix) FILTER_ARGUMENTS+=("--id-prefix" "${2:-}"); shift 2 ;;
    --non-disruptive-only) NON_DISRUPTIVE_ONLY="yes"; shift ;;
    --disposable) DISPOSABLE="yes"; shift ;;
    --allow-preexisting) ALLOW_PREEXISTING="yes"; shift ;;
    --list) LIST_ONLY="yes"; shift ;;
    --dry-run) DRY_RUN="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit "${EXIT_USAGE}" ;;
  esac
done

case "${MODE}" in
  smoke|full) ;;
  *) echo "unknown mode: ${MODE}" >&2; exit "${EXIT_USAGE}" ;;
esac
case "${SERVICE_MODE}" in
  user|system) ;;
  *) echo "unknown service mode: ${SERVICE_MODE}" >&2; exit "${EXIT_USAGE}" ;;
esac
if [[ ! "${SEED}" =~ ^[0-9]+$ ]]; then
  echo "seed must be a non-negative integer" >&2
  exit "${EXIT_USAGE}"
fi

# The authorized University of Science and Technology of China (USTC) server may
# run only non-disruptive cases at service scope. This profile makes that the
# only thing the runner can do there.
if [ "${PROFILE}" = "ustc-non-disruptive" ]; then
  NON_DISRUPTIVE_ONLY="yes"
  if [ "${SERVICE_MODE}" != "user" ]; then
    echo "the ustc-non-disruptive profile allows only the user service scope" >&2
    exit "${EXIT_USAGE}"
  fi
  if [ "${DISPOSABLE}" = "yes" ]; then
    echo "the ustc-non-disruptive profile must not be combined with --disposable" >&2
    exit "${EXIT_USAGE}"
  fi
fi
if [ "${NON_DISRUPTIVE_ONLY}" = "yes" ]; then
  FILTER_ARGUMENTS+=("--non-disruptive-only")
fi

# ---------------------------------------------------------------------------
# Environment preconditions
# ---------------------------------------------------------------------------

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1 ($2)" >&2
    exit "${EXIT_ENVIRONMENT}"
  fi
}

if [ "$(uname -s)" != "Linux" ]; then
  echo "This experiment is Linux-specific; it has no meaningful partial form elsewhere." >&2
  exit "${EXIT_ENVIRONMENT}"
fi
if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 3 ]; }; then
  echo "This script needs bash 4.3 or newer for name references." >&2
  exit "${EXIT_ENVIRONMENT}"
fi

require_command node "the case catalog, manifest, and summary are written with Node.js"
require_command systemctl "the experiment runs Core as a systemd service"
require_command python3 "ADR 0009 requires a Python 3 interpreter for the child launcher"
require_command find "the control group inventory uses find"
require_command timeout "each case runs under a finite deadline"

if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" != "cgroup2fs" ]; then
  echo "This experiment requires control group version 2 mounted at /sys/fs/cgroup." >&2
  exit "${EXIT_ENVIRONMENT}"
fi

SYSTEMCTL_SCOPE="--user"
if [ "${SERVICE_MODE}" = "system" ]; then
  SYSTEMCTL_SCOPE="--system"
elif [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "The user service scope requires a running systemd user manager (XDG_RUNTIME_DIR is unset)." >&2
  exit "${EXIT_ENVIRONMENT}"
fi

# shellcheck source=lib/safety.sh
. "${LIB_DIR}/safety.sh"

# ---------------------------------------------------------------------------
# Case selection
# ---------------------------------------------------------------------------

CATALOG="${LIB_DIR}/catalog.mjs"

# Runs the case catalog and refuses to continue when it produced nothing.
#
# `catalog.mjs` prints only when it is executed as a program, which it decides
# by comparing the invoked path with its own module URL. A work tree reached
# through a symbolic link made those differ, so the module loaded, printed
# nothing, and exited zero. Every reader below then saw an empty document, and
# none of them said so:
#
#   * JSON parsing reported a syntax error, which reads as "the catalog's
#     contents are broken" when the catalog never ran at all; and
#   * the disruptive gate saw an empty selection and permitted the run, which
#     is the dangerous one, because it would let a disruptive case start on a
#     machine that was never declared disposable.
#
# A guard that turns "run as a program" into "print nothing and succeed" is
# worse than one that crashes, so emptiness is checked here rather than left to
# whatever each reader happens to do with it.
# Every decision below reads the catalog as JSON, because only that form makes
# "the catalog did not run" distinguishable from "the filters matched nothing":
# an empty selection still prints a document with an empty `cases` array, while
# a catalog that never ran prints nothing at all. The tab-separated form cannot
# tell those apart, since a selection of no cases prints no lines either.
#
# Failure is reported through the return status, never by exiting. This is
# always called inside a command substitution, where `exit` ends only that
# subshell: the script would print this diagnosis and then carry on to fail
# again below with the unrelated message this check exists to replace.
load_catalog_json() {
  local output status=0
  output="$(node "${CATALOG}" --format json "$@")" || status=$?
  if [ "${status}" != "0" ]; then
    echo "The case catalog exited ${status}." >&2
    echo "Run it directly to see its error: node ${CATALOG} --format json" >&2
    return 1
  fi
  if [ -z "${output}" ]; then
    echo "The case catalog produced no output, and exited successfully." >&2
    echo "This is not a filter that matched nothing: an empty selection still prints" >&2
    echo "a document containing an empty cases array." >&2
    echo "The usual cause is that ${CATALOG} did not run as a program. Its entry guard" >&2
    echo "compares the invoked path with its own resolved module path, so reaching this" >&2
    echo "work tree through a symbolic link can make the module load, print nothing," >&2
    echo "and exit zero. Check the path this run used:" >&2
    echo "  ${SCRIPT_DIR}" >&2
    return 1
  fi
  if ! printf '%s' "${output}" | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => { text += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed.cases)) throw new Error("the document has no cases array");
        } catch (error) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
      });
    ' 2>/dev/null; then
    echo "The case catalog printed something that is not a usable catalog document." >&2
    echo "Inspect its first bytes: node ${CATALOG} --format json | head -c 200" >&2
    return 1
  fi
  printf '%s\n' "${output}"
}

# Read once, at top level, so every decision below works from the same document
# and the diagnosis above is both reported and acted on exactly once.
if ! CATALOG_SELECTED_JSON="$(load_catalog_json "${FILTER_ARGUMENTS[@]+"${FILTER_ARGUMENTS[@]}"}")"; then
  exit "${EXIT_ENVIRONMENT}"
fi

# Feeds the already-validated selected catalog to a reader script.
selected_cases() {
  printf '%s' "${CATALOG_SELECTED_JSON}" | node -e "$1"
}

if [ "${LIST_ONLY}" = "yes" ]; then
  # The load above already proved the catalog runs and parses, so `--list`
  # cannot answer with silence either.
  node "${CATALOG}" --format tsv "${FILTER_ARGUMENTS[@]+"${FILTER_ARGUMENTS[@]}"}"
  echo "---"
  node "${CATALOG}" --format counts "${FILTER_ARGUMENTS[@]+"${FILTER_ARGUMENTS[@]}"}"
  exit 0
fi

# A disruptive case must never run on a machine that was not declared
# disposable. This is checked before anything is created.
if [ "${DISPOSABLE}" != "yes" ]; then
  # Read as JSON rather than tab-separated text: a catalog that printed nothing
  # would otherwise leave this list empty and permit the run, which is the one
  # place where an unnoticed empty reading is a safety failure rather than an
  # inconvenience.
  DISRUPTIVE_SELECTED="$(
    printf '%s' "${CATALOG_SELECTED_JSON}" |
      node -e '
        let text = "";
        process.stdin.on("data", (chunk) => { text += chunk; });
        process.stdin.on("end", () => {
          const cases = JSON.parse(text).cases ?? [];
          process.stdout.write(
            cases.filter((entry) => entry.disruptive).map((entry) => entry.id).join("\n"),
          );
        });
      '
  )"
  if [ -n "${DISRUPTIVE_SELECTED}" ]; then
    echo "The selection contains cases that terminate the service manager, end a login session," >&2
    echo "reboot the machine, require privilege, or apply hostile resource pressure:" >&2
    printf '  %s\n' ${DISRUPTIVE_SELECTED} >&2
    echo "Pass --disposable only on a machine that may be destroyed, or --non-disruptive-only." >&2
    exit "${EXIT_ENVIRONMENT}"
  fi
fi

# An `--exclude-id` that matches no case in the catalog is a typo, and a typo
# here is invisible: the run proceeds with everything still selected while the
# operator believes a case was dropped. Reject it before anything is created.
if [ "${#EXCLUDED_REQUESTED[@]}" -gt 0 ]; then
  if ! CATALOG_ALL_JSON="$(load_catalog_json)"; then
    exit "${EXIT_ENVIRONMENT}"
  fi
  UNKNOWN_EXCLUDED="$(
    printf '%s' "${CATALOG_ALL_JSON}" |
      node -e '
        let text = "";
        process.stdin.on("data", (chunk) => { text += chunk; });
        process.stdin.on("end", () => {
          const known = new Set((JSON.parse(text).cases ?? []).map((entry) => entry.id));
          const unknown = process.argv.slice(1).filter((id) => !known.has(id));
          process.stdout.write(`${unknown.join(" ")}\n`);
        });
      ' "${EXCLUDED_REQUESTED[@]}"
  )"
  if [ -n "${UNKNOWN_EXCLUDED}" ]; then
    echo "These --exclude-id values match no case in the catalog:" >&2
    printf '  %s\n' ${UNKNOWN_EXCLUDED} >&2
    echo "An exclusion that matches nothing changes no selection, so the run would" >&2
    echo "silently keep every case the operator believed it had dropped." >&2
    echo "Use the exact case identifier as shown by --list." >&2
    exit "${EXIT_USAGE}"
  fi
fi

# A case the catalog marks `exclusive` destroys something every later case in the
# same run depends on, so it must be the only case in its run. The check runs
# here, before anything is created.
#
# This refuses rather than reordering or silently running the case on its own. An
# automatic correction would let an operator keep an invalid invocation and never
# learn it was invalid, and the run it produced would look ordinary. The failure
# mode being prevented is worse than a plain failure: the later cases still run,
# still fail, and report causes that have nothing to do with what they tested.
EXCLUSIVE_REPORT="$(
  printf '%s' "${CATALOG_SELECTED_JSON}" |
    node -e '
      let text = "";
      process.stdin.on("data", (chunk) => { text += chunk; });
      process.stdin.on("end", () => {
        const cases = JSON.parse(text).cases ?? [];
        const exclusive = cases.filter((entry) => entry.exclusive).map((entry) => entry.id);
        process.stdout.write(`${cases.length}\t${exclusive.join(" ")}\n`);
      });
    '
)"
SELECTED_TOTAL="${EXCLUSIVE_REPORT%%$'\t'*}"
EXCLUSIVE_IDS="${EXCLUSIVE_REPORT#*$'\t'}"
if [ -n "${EXCLUSIVE_IDS}" ] && [ "${SELECTED_TOTAL}" -gt 1 ]; then
  echo "The selection contains ${SELECTED_TOTAL} cases, and these must run on their own:" >&2
  printf '  %s\n' ${EXCLUSIVE_IDS} >&2
  echo "Such a case ends something the remaining cases need, so they would fail for that" >&2
  echo "reason instead of their own and the run would record misattributed failures." >&2
  echo "Run it by itself, for example:" >&2
  for exclusive_id in ${EXCLUSIVE_IDS}; do
    echo "  $0 --id-prefix ${exclusive_id}" >&2
  done
  echo "then run the rest of the selection separately." >&2
  exit "${EXIT_USAGE}"
fi

# ---------------------------------------------------------------------------
# Run directory
# ---------------------------------------------------------------------------

RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ID="${RUN_STAMP}-$$"
RUN_PREFIX="dolly-test-${RUN_ID}-"
if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="${REPOSITORY_ROOT}/artifacts/experiments/linux-core-service-ownership"
fi
RUN_DIR="${OUTPUT_DIR}/${RUN_ID}"
CASES_DIR="${RUN_DIR}/cases"
STATE_DIR="${RUN_DIR}/state"
mkdir -p "${CASES_DIR}" "${STATE_DIR}"

# Run artifacts are evidence, not source. Keeping the exclusion inside the
# output directory avoids editing the repository's own ignore file, which other
# work may be changing at the same time.
if [ ! -e "${OUTPUT_DIR}/.gitignore" ]; then
  printf '*\n' >"${OUTPUT_DIR}/.gitignore"
fi

MANIFEST_FILE="${RUN_DIR}/manifest.json"
CASE_LIST_FILE="${RUN_DIR}/ordered-cases.tsv"
RESULTS_FILE="${RUN_DIR}/results.jsonl"
SUMMARY_FILE="${RUN_DIR}/summary.json"
ENVIRONMENT_FILE="${RUN_DIR}/environment.env"
INVENTORY_BEFORE="${RUN_DIR}/inventory-before.txt"
INVENTORY_AFTER="${RUN_DIR}/inventory-after.txt"
# The unscoped readings and the items excluded from this run's residue check.
# Keeping the excluded set on disk is what makes a wrong scoping rule reviewable
# instead of silent.
INVENTORY_BEFORE_ALL="${RUN_DIR}/inventory-before-all.txt"
INVENTORY_AFTER_ALL="${RUN_DIR}/inventory-after-all.txt"
INVENTORY_FOREIGN_BEFORE="${RUN_DIR}/inventory-foreign-before.txt"
INVENTORY_FOREIGN_AFTER="${RUN_DIR}/inventory-foreign-after.txt"
# Foreign items present both before and after: candidate stale leftovers, as
# opposed to a concurrent run that started while this one was in progress.
INVENTORY_STALE_CANDIDATES="${RUN_DIR}/inventory-stale-candidates.txt"
CLEANUP_FILE="${RUN_DIR}/cleanup.json"
UNIT_LEDGER="${RUN_DIR}/created-units.txt"
CGROUP_LEDGER="${RUN_DIR}/created-cgroups.txt"
RUN_LOG="${RUN_DIR}/run.log"
: >"${RESULTS_FILE}"
: >"${UNIT_LEDGER}"
: >"${CGROUP_LEDGER}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${RUN_LOG}"
}

log "run ${RUN_ID} mode=${MODE} profile=${PROFILE} service-mode=${SERVICE_MODE}"
log "artifacts ${RUN_DIR}"

# ---------------------------------------------------------------------------
# Inventory before the run
# ---------------------------------------------------------------------------

# The full inventory is kept, then split into what this run owns and what
# belongs to another run. Residue is judged on this run's own items, because a
# run inside a privileged container is visible in the host's process list and
# would otherwise be reported as an unrelated run's residue.
#
# The cost of this scoping is stated rather than hidden: the old check refused to
# start whenever anything at all sat in the reserved namespace, which also caught
# stale leftovers from earlier runs. That hygiene signal is now a warning and a
# recorded file instead of a refusal, because it could not tell a stale leftover
# from a healthy concurrent run.
dolly_write_inventory "${SYSTEMCTL_SCOPE}" "${INVENTORY_BEFORE_ALL}"
dolly_partition_inventory "${INVENTORY_BEFORE_ALL}" "${RUN_PREFIX}" \
  "${INVENTORY_BEFORE}" "${INVENTORY_FOREIGN_BEFORE}"
PREEXISTING="$(wc -l <"${INVENTORY_BEFORE}" | tr -d ' ')"
FOREIGN_BEFORE="$(wc -l <"${INVENTORY_FOREIGN_BEFORE}" | tr -d ' ')"
log "inventory before: ${PREEXISTING} item(s) under this run's prefix, ${FOREIGN_BEFORE} belonging to another run"
if [ "${FOREIGN_BEFORE}" != "0" ]; then
  log "other runs' items are excluded from this run's residue check and recorded in ${INVENTORY_FOREIGN_BEFORE}"
fi
if [ "${PREEXISTING}" != "0" ] && [ "${ALLOW_PREEXISTING}" != "yes" ]; then
  # This run's prefix is unique, so anything already carrying it means the
  # prefix was reused or a previous run of this exact identity is still live.
  echo "The reserved namespace already contains items under this run's own prefix:" >&2
  cat "${INVENTORY_BEFORE}" >&2
  echo "Clean it up by hand, or pass --allow-preexisting to record it as the baseline." >&2
  exit "${EXIT_ENVIRONMENT}"
fi

# ---------------------------------------------------------------------------
# Environment facts for the manifest
# ---------------------------------------------------------------------------

collect_environment() {
  local file="$1"
  : >"${file}"
  {
    printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'host_name=%s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'user_name=%s\n' "$(id -un 2>/dev/null || echo unknown)"
    printf 'kernel_release=%s\n' "$(uname -r)"
    printf 'kernel_version=%s\n' "$(uname -v)"
    printf 'os_pretty_name=%s\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}") || printf 'unknown')"
    printf 'systemd_version=%s\n' "$(systemctl --version 2>/dev/null | head -1)"
    printf 'cgroup_filesystem=%s\n' "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"
    printf 'cgroup_version=%s\n' "2"
    printf 'cgroup_controllers=%s\n' "$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null | tr '\n' ' ')"
    printf 'node_version=%s\n' "$(node --version 2>/dev/null)"
    printf 'python3_version=%s\n' "$(python3 --version 2>&1)"
    printf 'service_mode=%s\n' "${SERVICE_MODE}"
    printf 'boot_id=%s\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
    printf 'disposable=%s\n' "${DISPOSABLE}"
    if [ "${SERVICE_MODE}" = "user" ]; then
      printf 'lingering=%s\n' "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
    else
      printf 'lingering=%s\n' "not-applicable"
    fi
    if command -v git >/dev/null 2>&1 && git -C "${REPOSITORY_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
      printf 'source_commit=%s\n' "$(git -C "${REPOSITORY_ROOT}" rev-parse HEAD)"
      printf 'source_commit_date=%s\n' "$(git -C "${REPOSITORY_ROOT}" show -s --format=%cI HEAD)"
      printf 'source_branch=%s\n' "$(git -C "${REPOSITORY_ROOT}" rev-parse --abbrev-ref HEAD)"
      local dirty_files
      dirty_files="$(git -C "${REPOSITORY_ROOT}" status --porcelain | wc -l | tr -d ' ')"
      printf 'source_dirty_files=%s\n' "${dirty_files}"
      if [ "${dirty_files}" = "0" ]; then
        printf 'source_dirty=no\n'
      else
        printf 'source_dirty=yes\n'
      fi
    else
      printf 'source_commit=unknown\n'
      printf 'source_dirty=yes\n'
      printf 'source_dirty_files=0\n'
    fi
    if [ -n "${CORE_UNIT}" ]; then
      printf 'core_unit=%s\n' "${CORE_UNIT}"
      if systemctl "${SYSTEMCTL_SCOPE}" show "${CORE_UNIT}" >"${RUN_DIR}/core-unit-show.txt" 2>/dev/null; then
        printf 'core_unit_show_file=%s\n' "${RUN_DIR}/core-unit-show.txt"
      else
        rm -f "${RUN_DIR}/core-unit-show.txt"
        printf 'core_unit_reason=the named Core service unit could not be inspected\n'
      fi
    else
      printf 'core_unit_reason=no Core service unit was supplied to this run\n'
    fi
  } >>"${file}"
}

collect_environment "${ENVIRONMENT_FILE}"

MANIFEST_ARGUMENTS=(
  --environment "${ENVIRONMENT_FILE}"
  --run-id "${RUN_ID}"
  --seed "${SEED}"
  --mode "${MODE}"
  --profile "${PROFILE}"
  --repository "${REPOSITORY_ROOT}"
  --manifest-out "${MANIFEST_FILE}"
  --cases-out "${CASE_LIST_FILE}"
)
if [ -n "${CORE_UNIT}" ]; then
  MANIFEST_ARGUMENTS+=(--core-unit "${CORE_UNIT}")
fi

SELECTED_COUNT="$(node "${LIB_DIR}/manifest.mjs" "${MANIFEST_ARGUMENTS[@]}" "${FILTER_ARGUMENTS[@]+"${FILTER_ARGUMENTS[@]}"}")"
log "manifest written; ${SELECTED_COUNT} case(s) selected"

# ---------------------------------------------------------------------------
# Case execution
# ---------------------------------------------------------------------------

# Only these values may reach the result ledger from a handler. Anything else is
# replaced, so handler output cannot inject content into the machine-readable
# summary.
sanitize_token() {
  local value="$1"
  local fallback="$2"
  if [[ "${value}" =~ ^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$ ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${fallback}"
  fi
}

read_outcome_field() {
  local file="$1"
  local key="$2"
  [ -f "${file}" ] || return 0
  awk -F'=' -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

json_string_array() {
  local first="yes"
  local item
  for item in "$@"; do
    if [ "${first}" = "yes" ]; then first="no"; else printf ','; fi
    printf '"%s"' "${item}"
  done
}

record_result() {
  local case_id="$1" group="$2" arm="$3" handler="$4" status="$5" reason="$6"
  local exit_code="$7" duration_ms="$8" timed_out="$9"
  local artifacts=("${@:10}")
  local iterations=1
  if [ "${status}" = "inconclusive" ] && [ "${#artifacts[@]}" -eq 0 ]; then
    iterations=0
  fi
  printf '{"caseId":"%s","group":"%s","arm":"%s","handler":"%s","status":"%s","reason":"%s","exitCode":%s,"durationMs":%s,"timedOut":%s,"retries":0,"iterations":%s,"artifacts":[%s],"invariantViolations":[],"cleanupResult":null}\n' \
    "${case_id}" "${group}" "${arm}" "${handler}" "${status}" "${reason}" \
    "${exit_code}" "${duration_ms}" "${timed_out}" "${iterations}" \
    "$(json_string_array "${artifacts[@]+"${artifacts[@]}"}")" >>"${RESULTS_FILE}"
}

now_ms() {
  date +%s%3N
}

executed=0
implemented=0
while IFS=$'\t' read -r case_id case_group case_handler case_arm case_timeout case_disruption case_artifacts <&3; do
  [ -n "${case_id}" ] || continue
  executed=$((executed + 1))

  handler_path="${HANDLERS_DIR}/${case_handler}.sh"
  if [ "${DRY_RUN}" = "yes" ]; then
    record_result "${case_id}" "${case_group}" "${case_arm}" "${case_handler}" \
      "inconclusive" "dry-run" 0 0 false
    continue
  fi
  # Presence, not the executable bit: a handler committed without it would
  # otherwise be silently treated as missing.
  if [ ! -f "${handler_path}" ]; then
    # No implementation exists, so there are no artifacts and the protocol
    # requires inconclusive rather than passed.
    record_result "${case_id}" "${case_group}" "${case_arm}" "${case_handler}" \
      "inconclusive" "case-handler-not-implemented" 0 0 false
    continue
  fi

  implemented=$((implemented + 1))
  case_dir="${CASES_DIR}/${case_id}"
  mkdir -p "${case_dir}"
  started_ms="$(now_ms)"
  handler_exit=0
  timed_out="false"
  DOLLY_EXPERIMENT_CASE_ID="${case_id}" \
  DOLLY_EXPERIMENT_CASE_GROUP="${case_group}" \
  DOLLY_EXPERIMENT_CASE_ARM="${case_arm}" \
  DOLLY_EXPERIMENT_CASE_DIR="${case_dir}" \
  DOLLY_EXPERIMENT_RUN_DIR="${RUN_DIR}" \
  DOLLY_EXPERIMENT_STATE_DIR="${STATE_DIR}" \
  DOLLY_EXPERIMENT_MANIFEST="${MANIFEST_FILE}" \
  DOLLY_EXPERIMENT_UNIT_PREFIX="${RUN_PREFIX}" \
  DOLLY_EXPERIMENT_UNIT_LEDGER="${UNIT_LEDGER}" \
  DOLLY_EXPERIMENT_CGROUP_LEDGER="${CGROUP_LEDGER}" \
  DOLLY_EXPERIMENT_SYSTEMCTL_SCOPE="${SYSTEMCTL_SCOPE}" \
  DOLLY_EXPERIMENT_SEED="${SEED}" \
  DOLLY_EXPERIMENT_REPOSITORY="${REPOSITORY_ROOT}" \
    timeout --kill-after=30s "${case_timeout}s" bash "${handler_path}" \
      >"${case_dir}/handler.stdout" 2>"${case_dir}/handler.stderr" </dev/null || handler_exit=$?
  duration_ms=$(( $(now_ms) - started_ms ))
  if [ "${handler_exit}" = "124" ] || [ "${handler_exit}" = "137" ]; then
    timed_out="true"
  fi

  status="$(sanitize_token "$(read_outcome_field "${case_dir}/case-outcome" status)" "inconclusive")"
  reason="$(sanitize_token "$(read_outcome_field "${case_dir}/case-outcome" reason)" "handler-reason-unreadable")"
  if [ "${timed_out}" = "true" ]; then
    status="inconclusive"
    reason="case-deadline-expired"
  fi

  retained=()
  IFS=',' read -r -a required <<<"${case_artifacts}"
  for artifact in "${required[@]}"; do
    if [ -s "${case_dir}/${artifact}" ] || [ -d "${case_dir}/${artifact}" ]; then
      retained+=("${artifact}")
    fi
  done
  record_result "${case_id}" "${case_group}" "${case_arm}" "${case_handler}" \
    "${status}" "${reason}" "${handler_exit}" "${duration_ms}" "${timed_out}" "${retained[@]+"${retained[@]}"}"
done 3<"${CASE_LIST_FILE}"

log "walked ${executed} case(s); ${implemented} had a handler"

# ---------------------------------------------------------------------------
# Cleanup and residue proof
# ---------------------------------------------------------------------------

CLEANUP_NOTES=()
UNITS_ATTEMPTED=0
UNITS_FAILED=0
CGROUPS_ATTEMPTED=0
CGROUPS_FAILED=0
STATE_REMOVED="false"

# A control group may be removed only when it lives under the control group
# filesystem, carries this run's own reserved prefix, is listed in the ledger the
# runner itself wrote, and reports no process.
dolly_cleanup_units "${SYSTEMCTL_SCOPE}" "${UNIT_LEDGER}" "${RUN_PREFIX}" \
  UNITS_ATTEMPTED UNITS_FAILED CLEANUP_NOTES
dolly_cleanup_cgroups "${CGROUP_LEDGER}" "/sys/fs/cgroup" "${RUN_PREFIX}" \
  CGROUPS_ATTEMPTED CGROUPS_FAILED CLEANUP_NOTES
dolly_cleanup_state_directory "${STATE_DIR}" "${RUN_DIR}" STATE_REMOVED CLEANUP_NOTES

dolly_write_inventory "${SYSTEMCTL_SCOPE}" "${INVENTORY_AFTER_ALL}"
dolly_partition_inventory "${INVENTORY_AFTER_ALL}" "${RUN_PREFIX}" \
  "${INVENTORY_AFTER}" "${INVENTORY_FOREIGN_AFTER}"
FOREIGN_AFTER="$(wc -l <"${INVENTORY_FOREIGN_AFTER}" | tr -d ' ')"
# Items that belong to another run and appeared while this run was in progress.
# They are not this run's residue, but a reader deciding whether the scoping is
# right needs to see that the excluded set changed under it.
FOREIGN_ADDED="$(LC_ALL=C comm -13 \
  <(LC_ALL=C sort -u "${INVENTORY_FOREIGN_BEFORE}") \
  <(LC_ALL=C sort -u "${INVENTORY_FOREIGN_AFTER}") | wc -l | tr -d ' ')"

# Foreign items that were already there when this run started and are still
# there now. The distinction matters: an item that appeared during the run is a
# healthy concurrent run, while one present throughout is a candidate stale
# leftover. Scoping stopped refusing to start on those, so the only thing that
# will ever surface them is this set being written down and someone reading it.
LC_ALL=C comm -12 \
  <(LC_ALL=C sort -u "${INVENTORY_FOREIGN_BEFORE}") \
  <(LC_ALL=C sort -u "${INVENTORY_FOREIGN_AFTER}") >"${INVENTORY_STALE_CANDIDATES}"
FOREIGN_THROUGHOUT="$(wc -l <"${INVENTORY_STALE_CANDIDATES}" | tr -d ' ')"

log "inventory after: ${FOREIGN_AFTER} item(s) belonging to another run were excluded (${FOREIGN_ADDED} appeared during this run)"
if [ "${FOREIGN_THROUGHOUT}" != "0" ]; then
  log "${FOREIGN_THROUGHOUT} item(s) were present before and after this run and are stale-leftover candidates; see ${INVENTORY_STALE_CANDIDATES}"
fi

CLEANUP_OK="true"
if [ "${UNITS_FAILED}" -gt 0 ] || [ "${CGROUPS_FAILED}" -gt 0 ] || [ "${STATE_REMOVED}" != "true" ]; then
  CLEANUP_OK="false"
fi

{
  printf '{"ok":%s,' "${CLEANUP_OK}"
  printf '"units":{"attempted":%s,"failed":%s},' "${UNITS_ATTEMPTED}" "${UNITS_FAILED}"
  printf '"cgroups":{"attempted":%s,"failed":%s},' "${CGROUPS_ATTEMPTED}" "${CGROUPS_FAILED}"
  printf '"stateDirectoryRemoved":%s,' "${STATE_REMOVED}"
  # The residue verdict is scoped to this run, so the summary must also carry
  # what that scoping excluded and where the excluded items are recorded.
  printf '"residueScope":{"runPrefix":"%s",' "${RUN_PREFIX}"
  printf '"excludedBefore":%s,"excludedAfter":%s,"excludedAppearedDuringRun":%s,' \
    "${FOREIGN_BEFORE}" "${FOREIGN_AFTER}" "${FOREIGN_ADDED}"
  # Present before and after: not this run's residue, but the set that used to
  # be caught by the pre-run refusal this scoping replaced.
  printf '"excludedPresentThroughout":%s,' "${FOREIGN_THROUGHOUT}"
  printf '"staleCandidateFile":"inventory-stale-candidates.txt",'
  printf '"excludedFiles":["inventory-foreign-before.txt","inventory-foreign-after.txt"],'
  printf '"unscopedFiles":["inventory-before-all.txt","inventory-after-all.txt"]},'
  printf '"notes":[%s]}\n' "$(json_string_array "${CLEANUP_NOTES[@]+"${CLEANUP_NOTES[@]}"}")"
} >"${CLEANUP_FILE}"

log "cleanup ok=${CLEANUP_OK} units=${UNITS_ATTEMPTED}/${UNITS_FAILED} cgroups=${CGROUPS_ATTEMPTED}/${CGROUPS_FAILED}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

summary_exit=0
node "${LIB_DIR}/summarize.mjs" \
  --manifest "${MANIFEST_FILE}" \
  --results "${RESULTS_FILE}" \
  --inventory-before "${INVENTORY_BEFORE}" \
  --inventory-after "${INVENTORY_AFTER}" \
  --cleanup "${CLEANUP_FILE}" \
  --output "${SUMMARY_FILE}" | tee -a "${RUN_LOG}" || summary_exit=$?

log "summary written to ${SUMMARY_FILE}"

case "${summary_exit}" in
  0) exit 0 ;;
  4) exit "${EXIT_INCOMPLETE}" ;;
  *) exit "${EXIT_FAILURE}" ;;
esac
