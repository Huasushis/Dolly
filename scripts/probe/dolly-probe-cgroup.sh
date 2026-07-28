#!/bin/bash
# dolly-probe-cgroup.sh
# Non-destructive cgroup v2 delegation probe for ADR 0009 mechanisms.
# Intended to run as the MAIN process of a transient systemd user service
# started with: Delegate=yes DelegateSubgroup=core Type=exec (or --wait).
# It touches only its own delegated service subtree and /dev/shm/dolly-probe-*.
# Prints KEY=VALUE lines on standard output; never signals by recovered PID.
set -u

say() { echo "$1"; }

SELF_CG=$(grep -m1 '^0::' /proc/self/cgroup | cut -d: -f3-)
say "self_cgroup=$SELF_CG"
case "$SELF_CG" in
  */core) say "in_core_subgroup=yes" ;;
  *) say "in_core_subgroup=no" ;;
esac
SERVICE_REL=$(dirname "$SELF_CG")
ROOT="/sys/fs/cgroup$SERVICE_REL"
say "service_root=$ROOT"

say "root_procs=[$(tr '\n' ' ' < "$ROOT/cgroup.procs" 2>/dev/null)]"
say "root_controllers=$(cat "$ROOT/cgroup.controllers" 2>/dev/null)"

if echo '+cpu +memory +pids' > "$ROOT/cgroup.subtree_control" 2>/dev/null; then
  say "subtree_enable=ok"
else
  say "subtree_enable=FAILED"
fi
say "subtree_control_readback=$(cat "$ROOT/cgroup.subtree_control" 2>/dev/null)"

M="$ROOT/mod1"
mkdir "$M" 2>/dev/null && say "mod1_mkdir=ok" || say "mod1_mkdir=FAILED"
echo 67108864 > "$M/memory.max" 2>/dev/null && say "memory_max_write=ok" || say "memory_max_write=FAILED"
say "memory_max_readback=$(cat "$M/memory.max" 2>/dev/null)"
echo 1 > "$M/memory.oom.group" 2>/dev/null && say "oom_group_write=ok" || say "oom_group_write=FAILED"
say "oom_group_readback=$(cat "$M/memory.oom.group" 2>/dev/null)"
echo 10 > "$M/pids.max" 2>/dev/null && say "pids_max_write=ok" || say "pids_max_write=FAILED"
say "pids_max_readback=$(cat "$M/pids.max" 2>/dev/null)"
echo '50000 100000' > "$M/cpu.max" 2>/dev/null && say "cpu_max_write=ok" || say "cpu_max_write=FAILED"
say "cpu_max_readback=$(cat "$M/cpu.max" 2>/dev/null)"

# Launcher-style self-migration: the child writes ITS OWN pid, then execs.
( echo "$BASHPID" > "$M/cgroup.procs" && exec sleep 300 ) &
MIG1=$!
sleep 0.3
say "mod1_procs_after_selfmove=[$(tr '\n' ' ' < "$M/cgroup.procs" 2>/dev/null)]"
say "mod1_events_after_selfmove=$(grep populated "$M/cgroup.events" 2>/dev/null)"

# pids.max enforcement: a shell inside mod1 forks past the limit of 10.
( echo "$BASHPID" > "$M/cgroup.procs" || exit 1
  for i in $(seq 1 15); do sleep 120 & done
  wait ) 2>/dev/null &
FORKER=$!
sleep 1
say "pids_current=$(cat "$M/pids.current" 2>/dev/null)"
say "pids_events=$(tr '\n' ' ' < "$M/pids.events" 2>/dev/null)"

# Whole-group kill and populated-0 proof.
echo 1 > "$M/cgroup.kill" 2>/dev/null && say "cgroup_kill_write=ok" || say "cgroup_kill_write=FAILED"
POP=timeout
for i in $(seq 1 100); do
  if grep -q '^populated 0' "$M/cgroup.events" 2>/dev/null; then
    POP="populated0_after_${i}_polls"
    break
  fi
  sleep 0.05
done
say "kill_result=$POP"
say "mod1_procs_after_kill=[$(tr '\n' ' ' < "$M/cgroup.procs" 2>/dev/null)]"
rmdir "$M" 2>/dev/null && say "mod1_rmdir=ok" || say "mod1_rmdir=FAILED"
wait "$MIG1" 2>/dev/null
wait "$FORKER" 2>/dev/null

# memory.oom.group: everything inside mod2 must die together on OOM.
M2="$ROOT/mod2"
mkdir "$M2" 2>/dev/null
echo 8388608 > "$M2/memory.max" 2>/dev/null
echo 0 > "$M2/memory.swap.max" 2>/dev/null || true
echo 1 > "$M2/memory.oom.group" 2>/dev/null
( echo "$BASHPID" > "$M2/cgroup.procs" && exec sleep 300 ) &
BUDDY=$!
( echo "$BASHPID" > "$M2/cgroup.procs" || exit 1
  exec dd if=/dev/zero of=/dev/shm/dolly-probe-oom bs=1M count=64 ) 2>/dev/null &
EATER=$!
OOMRES=timeout
for i in $(seq 1 100); do
  if grep -q '^populated 0' "$M2/cgroup.events" 2>/dev/null; then
    OOMRES="group_emptied_after_${i}_polls"
    break
  fi
  sleep 0.1
done
say "oom_group_result=$OOMRES"
say "memory_events=$(tr '\n' ' ' < "$M2/memory.events" 2>/dev/null)"
rm -f /dev/shm/dolly-probe-oom
rmdir "$M2" 2>/dev/null && say "mod2_rmdir=ok" || say "mod2_rmdir=FAILED"
wait "$BUDDY" 2>/dev/null
wait "$EATER" 2>/dev/null

# RLIMIT_NOFILE applied before exec, observed after exec (launcher pattern).
say "rlimit_nofile=$( (ulimit -n 64; exec awk '/Max open files/{print $4, $5}' /proc/self/limits) 2>/dev/null )"

say "probe_done=yes"
exit 0
