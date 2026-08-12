#!/usr/bin/python3
"""Reports whether a candidate Linux process boundary contains its process tree.

The fixture is intentionally hostile but non-destructive.  It addresses only
literal test-owned paths and the Core test process identifier supplied by the
test.  The signal probe uses signal zero, so it never changes the target.  A
fixed alarm prevents a failed group-termination test from waiting forever.
"""

import ctypes
import errno
import json
import os
import signal
import socket


signal.alarm(30)

CORE_PID = int(os.environ["DOLLY_TEST_CORE_PID"])
CORE_STATE_MARKER = os.environ["DOLLY_TEST_CORE_STATE_MARKER"]
USER_BUS = "/run/user/%d/bus" % os.getuid()
CGROUP_ROOT = "/sys/fs/cgroup"


def attempt(action):
    try:
        return {"outcome": "succeeded", "detail": action()}
    except OSError as error:
        return {
            "outcome": "denied",
            "errno": error.errno,
            "errnoName": errno.errorcode.get(error.errno),
        }


def open_for_write(path):
    descriptor = os.open(path, os.O_WRONLY)
    os.close(descriptor)
    return {"opened": True}


def read_one(path):
    with open(path, "rb") as handle:
        return {"bytes": len(handle.read(1))}


def connect_unix(path):
    handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        handle.connect(path)
    finally:
        handle.close()
    return {"connected": True}


def probe_signal():
    os.kill(CORE_PID, 0)
    return {"visible": True}


def unshare_user_namespace():
    clone_new_user = 0x10000000
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(clone_new_user) != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))
    return {"created": True}


def mount_cgroup_again():
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.mount(
        ctypes.c_char_p(b"none"),
        ctypes.c_char_p(CGROUP_ROOT.encode("utf-8")),
        ctypes.c_char_p(b"cgroup2"),
        ctypes.c_ulong(0),
        ctypes.c_void_p(),
    )
    if result != 0:
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))
    return {"mounted": True}


def child_report():
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(read_end)
            report = {
                "cgroup": open("/proc/self/cgroup", "r", encoding="utf-8").read().strip(),
                "cgroupWrite": attempt(lambda: open_for_write(CGROUP_ROOT + "/cgroup.procs")),
            }
            os.write(write_end, (json.dumps(report, sort_keys=True) + "\n").encode("utf-8"))
            os.close(write_end)
        finally:
            os._exit(0)
    os.close(write_end)
    payload = os.read(read_end, 16_384)
    os.close(read_end)
    _, status = os.waitpid(child, 0)
    return {"status": status, "report": json.loads(payload)}


report = {
    "schemaVersion": "dolly.linux-process-confinement-probe/1",
    "selfCgroup": open("/proc/self/cgroup", "r", encoding="utf-8").read().strip(),
    "cgroupNamespace": os.readlink("/proc/self/ns/cgroup"),
    "pidNamespace": os.readlink("/proc/self/ns/pid"),
    "cgroupWrite": attempt(lambda: open_for_write(CGROUP_ROOT + "/cgroup.procs")),
    "memoryLimitWrite": attempt(lambda: open_for_write(CGROUP_ROOT + "/memory.max")),
    "nestedUserNamespace": attempt(unshare_user_namespace),
    "secondCgroupMount": attempt(mount_cgroup_again),
    "coreSignalProbe": attempt(probe_signal),
    "coreProcRead": attempt(lambda: read_one("/proc/%d/status" % CORE_PID)),
    "coreStateRead": attempt(lambda: read_one(CORE_STATE_MARKER)),
    "userManagerConnect": attempt(lambda: connect_unix(USER_BUS)),
    "descendant": child_report(),
}

print(json.dumps(report, sort_keys=True), flush=True)
signal.pause()
