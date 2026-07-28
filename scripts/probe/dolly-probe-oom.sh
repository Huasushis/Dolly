#!/bin/bash
# dolly-probe-oom.sh
# Corrected memory.oom.group probe: waits for membership BEFORE polling,
# so the earlier populated-race cannot produce a false positive.
set -u
say() { echo "$1"; }

SELF_CG=$(grep -m1 '^0::' /proc/self/cgroup | cut -d: -f3-)
SERVICE_REL=$(dirname "$SELF_CG")
ROOT="/sys/fs/cgroup$SERVICE_REL"
say "service_root=$ROOT"

echo '+memory +pids' > "$ROOT/cgroup.subtree_control" 2>/dev/null || say "subtree_enable=FAILED"

M2="$ROOT/mod2"
mkdir "$M2" 2>/dev/null || say "mod2_mkdir=FAILED"
echo 8388608 > "$M2/memory.max" 2>/dev/null || say "memory_max_write=FAILED"
echo 0 > "$M2/memory.swap.max" 2>/dev/null && say "swap_max_write=ok" || say "swap_max_write=unavailable"
echo 1 > "$M2/memory.oom.group" 2>/dev/null || say "oom_group_write=FAILED"

( echo "$BASHPID" > "$M2/cgroup.procs" && exec sleep 300 ) &
BUDDY=$!
JOINED=no
for i in $(seq 1 100); do
  if grep -q '^populated 1' "$M2/cgroup.events" 2>/dev/null; then JOINED=yes; break; fi
  sleep 0.05
done
say "buddy_joined=$JOINED"
say "mod2_events_before=$(grep populated "$M2/cgroup.events" 2>/dev/null)"

( echo "$BASHPID" > "$M2/cgroup.procs" && exec dd if=/dev/zero of=/dev/shm/dolly-probe-oom bs=1M count=64 ) 2>/dev/null &
EATER=$!

OOMRES=timeout
for i in $(seq 1 200); do
  if grep -q '^populated 0' "$M2/cgroup.events" 2>/dev/null; then
    OOMRES="group_emptied_after_${i}_polls"
    break
  fi
  sleep 0.1
done
say "oom_group_result=$OOMRES"
say "memory_events=$(tr '\n' ' ' < "$M2/memory.events" 2>/dev/null)"
if kill -0 "$BUDDY" 2>/dev/null; then say "buddy_gone=no"; else say "buddy_gone=yes"; fi
rm -f /dev/shm/dolly-probe-oom
rmdir "$M2" 2>/dev/null && say "mod2_rmdir=ok" || say "mod2_rmdir=FAILED"
wait "$BUDDY" 2>/dev/null
wait "$EATER" 2>/dev/null
say "probe_done=yes"
exit 0
