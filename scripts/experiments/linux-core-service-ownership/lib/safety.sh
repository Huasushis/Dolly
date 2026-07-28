#!/bin/bash
# Inventory and cleanup helpers for the Linux Core service process ownership
# experiment runner. Sourced by run.sh; not meant to be executed directly.
#
# The protocol's "Safety and cleanup" section allows the harness to stop only
# the exact test service names it created, requires an inventory before and
# after the run, requires proof that a control group holds no process before its
# test state is removed, and forbids removing any path, service, process, or
# control group discovered from untrusted output. Every rule is implemented
# here, and every removal re-validates its target instead of trusting the
# ledger it came from.

# A name the harness may act on. The prefix is reserved for this harness.
readonly DOLLY_TEST_UNIT_PATTERN='^dolly-test-[A-Za-z0-9][A-Za-z0-9._-]*\.service$'
readonly DOLLY_TEST_CGROUP_BASENAME_PATTERN='^dolly-test-[A-Za-z0-9][A-Za-z0-9._-]*$'

# Enumerates everything in the reserved test namespace that currently exists.
# Read-only: it starts, stops, and removes nothing. Output is one
# `kind<TAB>identity` line per item, sorted, so two inventories can be compared
# line by line.
dolly_inventory() {
  local scope_flag="$1"

  systemctl "${scope_flag}" list-units --all --no-legend --plain 'dolly-test-*' 2>/dev/null |
    awk '{ print "unit\t" $1 }' || true

  # `list-units` omits units that exist only as leftover transient state, so
  # the failed list is enumerated separately.
  systemctl "${scope_flag}" list-units --all --state=failed --no-legend --plain 'dolly-test-*' 2>/dev/null |
    awk '{ print "unit\t" $1 }' || true

  find /sys/fs/cgroup -maxdepth 8 -type d -name 'dolly-test-*' 2>/dev/null |
    sed 's/^/cgroup\t/' || true

  find /sys/fs/cgroup -maxdepth 8 -type d -name 'dolly-module-*' 2>/dev/null |
    sed 's/^/cgroup\t/' || true

  dolly_inventory_processes
}

# The process identifiers of this shell and everything that started it. The
# command that launches a run may itself mention the reserved prefix, and that
# is not leftover state, so those processes are excluded from the inventory.
dolly_self_and_ancestors() {
  local pid=$$
  while [ -n "${pid}" ] && [ "${pid}" -gt 1 ] 2>/dev/null; do
    printf '%s\n' "${pid}"
    # Field 2 after the command name, which may itself contain spaces and
    # parentheses, is the parent process identifier.
    pid="$(sed 's/.*) //' "/proc/${pid}/stat" 2>/dev/null | cut -d' ' -f2)"
  done
}

# Command lines rather than process identifiers, so the comparison is stable
# across runs. This enumerates; it never signals.
#
# Limitation worth knowing: this finds a leftover process only when its command
# line carries the reserved prefix or it is still inside a reserved control
# group. A fixture that escaped both would need a different signal, which is
# itself one of the things the experiment tests.
dolly_inventory_processes() {
  local excluded pid cmdline
  excluded="$(dolly_self_and_ancestors | tr '\n' ' ')"
  while IFS= read -r pid; do
    [ -n "${pid}" ] || continue
    case " ${excluded} " in *" ${pid} "*) continue ;; esac
    # A command line may contain argument separators and embedded newlines. The
    # inventory is one item per line, so all whitespace is squashed and the
    # result is bounded before it is recorded.
    cmdline="$(tr '\0\n\r\t' '    ' <"/proc/${pid}/cmdline" 2>/dev/null | tr -s ' ' | cut -c1-200 || true)"
    [ -n "${cmdline}" ] || continue
    printf 'process\t%s\n' "${cmdline}"
  done < <(pgrep -f 'dolly-test-' 2>/dev/null || true)
}

dolly_write_inventory() {
  local scope_flag="$1"
  local destination="$2"
  dolly_inventory "${scope_flag}" | LC_ALL=C sort -u >"${destination}"
}

# Splits one inventory into the items that belong to this run and the items that
# carry the reserved prefix but belong to some other run.
#
# Why this exists: the reserved `dolly-test-` namespace is shared by every run
# on the machine, and a run inside a privileged container is visible in the
# host's process list. A concurrent run therefore appears in an unrelated run's
# "after" inventory and is reported as that run's residue, which is a false
# INV-12 violation. Ownership is decided by this run's own unique prefix, which
# is the only attribution the harness actually has.
#
# The excluded items are written out rather than dropped. A scoping rule that is
# too wide turns a false residue report into a silent missed one, and a silent
# missed one produces no signal at all; keeping the excluded set on disk is what
# makes that mistake reviewable.
dolly_partition_inventory() {
  local source="$1"
  local run_prefix="$2"
  local mine="$3"
  local foreign="$4"

  : >"${mine}"
  : >"${foreign}"
  [ -f "${source}" ] || return 0

  local line
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    if [[ "${line}" == *"${run_prefix}"* ]]; then
      printf '%s\n' "${line}" >>"${mine}"
    else
      printf '%s\n' "${line}" >>"${foreign}"
    fi
  done <"${source}"
}

# Appends a unit name the run created, so cleanup knows exactly what to stop.
# Refuses any name outside the reserved prefix.
dolly_ledger_add_unit() {
  local ledger="$1"
  local unit="$2"
  if [[ ! "${unit}" =~ ${DOLLY_TEST_UNIT_PATTERN} ]]; then
    echo "refusing to record unit name outside the reserved test prefix: ${unit}" >&2
    return 1
  fi
  printf '%s\n' "${unit}" >>"${ledger}"
}

# Appends a control group path the run created. It must sit under the delegated
# root the caller names and carry this run's own prefix, so no path from
# anywhere else can enter the ledger.
dolly_ledger_add_cgroup() {
  local ledger="$1"
  local root="$2"
  local run_prefix="$3"
  local path="$4"
  local name
  name="$(basename "${path}")"
  if [[ "${path}" != "${root}/"* || "${path}" == *".."* ]]; then
    echo "refusing to record control group path outside the run root: ${path}" >&2
    return 1
  fi
  if [[ ! "${name}" =~ ${DOLLY_TEST_CGROUP_BASENAME_PATTERN} || "${name}" != "${run_prefix}"* ]]; then
    echo "refusing to record control group name outside this run's reserved prefix: ${path}" >&2
    return 1
  fi
  printf '%s\n' "${path}" >>"${ledger}"
}

# Stops exactly the units this run recorded. Every name is validated again here
# and must additionally carry this run's own prefix, so a corrupted ledger
# cannot widen the blast radius.
dolly_cleanup_units() {
  local scope_flag="$1"
  local ledger="$2"
  local run_prefix="$3"
  local -n attempted_ref="$4"
  local -n failed_ref="$5"
  local -n notes_ref="$6"

  attempted_ref=0
  failed_ref=0
  [ -f "${ledger}" ] || return 0

  local unit
  while IFS= read -r unit; do
    [ -n "${unit}" ] || continue
    if [[ ! "${unit}" =~ ${DOLLY_TEST_UNIT_PATTERN} ]]; then
      notes_ref+=("skipped ledger entry outside the reserved test prefix")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    if [[ "${unit}" != "${run_prefix}"* ]]; then
      notes_ref+=("skipped ledger entry that does not belong to this run")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    attempted_ref=$((attempted_ref + 1))
    systemctl "${scope_flag}" stop "${unit}" >/dev/null 2>&1 || true
    systemctl "${scope_flag}" reset-failed "${unit}" >/dev/null 2>&1 || true
    if systemctl "${scope_flag}" is-active --quiet "${unit}" 2>/dev/null; then
      notes_ref+=("unit still active after stop")
      failed_ref=$((failed_ref + 1))
    fi
  done <"${ledger}"
}

# Removes exactly the control groups this run recorded, and only after the
# kernel reports that the group holds no process. `rmdir` is used deliberately:
# it cannot delete a non-empty tree, so a mistake cannot cascade.
dolly_cleanup_cgroups() {
  local ledger="$1"
  local root="$2"
  local run_prefix="$3"
  local -n attempted_ref="$4"
  local -n failed_ref="$5"
  local -n notes_ref="$6"

  attempted_ref=0
  failed_ref=0
  [ -f "${ledger}" ] || return 0

  local path
  # Deepest first, so a child is removed before its parent.
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    if [[ "${path}" != "${root}/"* || "${path}" == *".."* ]]; then
      notes_ref+=("skipped control group path outside the run root")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    local name
    name="$(basename "${path}")"
    if [[ ! "${name}" =~ ${DOLLY_TEST_CGROUP_BASENAME_PATTERN} ]]; then
      notes_ref+=("skipped control group name outside the reserved test prefix")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    if [[ "${name}" != "${run_prefix}"* ]]; then
      notes_ref+=("skipped control group that does not belong to this run")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    [ -d "${path}" ] || continue
    attempted_ref=$((attempted_ref + 1))
    if ! grep -q '^populated 0' "${path}/cgroup.events" 2>/dev/null; then
      notes_ref+=("control group still populated; left in place for inspection")
      failed_ref=$((failed_ref + 1))
      continue
    fi
    if ! rmdir "${path}" 2>/dev/null; then
      notes_ref+=("control group removal failed")
      failed_ref=$((failed_ref + 1))
    fi
  done < <(LC_ALL=C sort -r "${ledger}")
}

# Removes the run's own state directory. The path is the one the runner created
# under its own output directory; it is never taken from case output.
dolly_cleanup_state_directory() {
  local state_dir="$1"
  local output_dir="$2"
  local -n removed_ref="$3"
  local -n notes_ref="$4"

  removed_ref="false"
  [ -d "${state_dir}" ] || { removed_ref="true"; return 0; }
  if [[ "${state_dir}" != "${output_dir}/"* || "${state_dir}" == *".."* ]]; then
    notes_ref+=("refused to remove a state directory outside the run output directory")
    return 0
  fi
  if rm -rf "${state_dir}" 2>/dev/null; then
    removed_ref="true"
  else
    notes_ref+=("state directory removal failed")
  fi
}
