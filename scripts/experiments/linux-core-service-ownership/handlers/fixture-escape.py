#!/usr/bin/env python3
"""Hostile Module fixture for the sandbox-escape cases SC-14-01 to SC-14-11.

This is the "untrusted sandbox fixture" required failure test 6 of Architecture
Decision Record (ADR) 0009 asks for. It runs as the Module process inside one
prepared Module control group, started by the reviewed child launcher, and it
tries every escape the decision says must fail.

Rules this file keeps, so running it stays safe on a shared machine:

  * it takes no command-line argument, reads no environment variable, and opens
    no channel that could feed it a target: every path, name, and sentinel
    below is a literal constant, and the only value it derives at run time is
    its own user identity and its own control-group path;
  * it signals only a process whose command line contains the exact constant
    `CORE_STANDIN_SENTINEL`, which the case driver puts on a process it created
    for this purpose. No other process can be signalled by this script;
  * it never writes a process identifier into any control group outside the
    delegated service root it already lives in, and it returns itself to its
    Module control group immediately afterwards;
  * where the interesting question is whether the authority exists rather than
    what the authority would do, it opens the file for writing and closes it
    without writing, or connects a socket and closes it without sending;
  * it contacts no host other than the loopback address, and creates no
    lasting file; and
  * a fixed alarm ends it whatever happens.

It reports one JSON object describing every attempt: whether it succeeded or
was denied, and with which errno. The driver asserts on those exact values.
"""

import errno
import json
import os
import signal
import socket
import stat
import sys
import tempfile
import time

DEADLINE_SECONDS = 25

CGROUP_MOUNT_POINT = "/sys/fs/cgroup"
CORE_STANDIN_SENTINEL = "dolly-test-core-standin-sentinel"
CORE_SECRET_ENV_NAME = "DOLLY_TEST_CORE_SECRET_SENTINEL"
CORE_SECRET_ENV_VALUE = "dolly-test-core-secret-1f7a"
CORE_STATE_PROBE_PATH = "/tmp/dolly-test-escape-probe/core-state.json"
CORE_STATE_SENTINEL = "dolly-test-core-state-sentinel"
ESCAPE_CHILD_CGROUP_NAME = "dolly-test-escape-child"
ESCAPE_SIBLING_CGROUP_NAME = "dolly-test-escape-sibling"
SYSTEM_MANAGER_PRIVATE_SOCKET = "/run/systemd/private"
AMBIENT_READ_PATH = "/etc/hostname"
LOOPBACK_REFUSED_PORT = 1

signal.alarm(DEADLINE_SECONDS)

results = {}


def record(name, outcome, error=None, detail=None):
    entry = {"outcome": outcome, "errno": None, "errno_name": None, "detail": detail}
    if error is not None:
        entry["errno"] = error.errno
        entry["errno_name"] = errno.errorcode.get(error.errno)
        entry["detail"] = detail if detail is not None else str(error)
    results[name] = entry


def attempt(name, action):
    """Runs one escape attempt and records exactly how it ended."""
    try:
        record(name, "succeeded", detail=action())
    except OSError as error:
        record(name, "denied", error=error)
    except Exception as error:  # noqa: BLE001 - a fixture must never abort early
        record(name, "error", detail=repr(error))


def own_cgroup_path():
    with open("/proc/self/cgroup", "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("0::"):
                return CGROUP_MOUNT_POINT + line[3:].strip()
    raise RuntimeError("no cgroup version 2 line in /proc/self/cgroup")


def read_text(path, limit=4096):
    with open(path, "rb") as handle:
        return handle.read(limit).decode("utf-8", "replace")


def find_core_standin():
    """Finds the process the driver marked with the fixed sentinel."""
    matches = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/" + name + "/cmdline", "rb") as handle:
                cmdline = handle.read(4096).decode("utf-8", "replace")
        except OSError:
            continue
        if CORE_STANDIN_SENTINEL in cmdline:
            matches.append(int(name))
    return matches


own = own_cgroup_path()
parent = own.rsplit("/", 1)[0]
uid = os.getuid()
user_manager_cgroup_procs = "%s/user.slice/user-%d.slice/user@%d.service/cgroup.procs" % (
    CGROUP_MOUNT_POINT,
    uid,
    uid,
)
user_bus_socket = "/run/user/%d/bus" % uid
user_manager_private_socket = "/run/user/%d/systemd/private" % uid

standins = find_core_standin()
core_pid = min(standins) if len(standins) == 1 else None

# --- SC-14-08: descriptors that must not have survived exec -----------------


def descriptor_state(number):
    def action():
        info = os.fstat(number)
        return {"present": True, "mode": stat.S_IFMT(info.st_mode)}

    return action


attempt("inherited_control_descriptor_3", descriptor_state(3))
attempt("inherited_extra_descriptor_4", descriptor_state(4))
attempt(
    "open_descriptor_list",
    lambda: sorted(int(n) for n in os.listdir("/proc/self/fd") if n.isdigit()),
)

# --- SC-14-09: ambient filesystem authority ---------------------------------

attempt("ambient_read_outside_scratch", lambda: read_text(AMBIENT_READ_PATH, 64).strip())


def ambient_write():
    descriptor, path = tempfile.mkstemp(prefix="dolly-test-ambient-")
    try:
        os.write(descriptor, b"dolly-test-ambient-write")
    finally:
        os.close(descriptor)
        os.unlink(path)
    return {"created_and_removed": True}


attempt("ambient_write_outside_scratch", ambient_write)

# --- SC-14-10: ambient network authority ------------------------------------


def ambient_network():
    handle = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    handle.settimeout(2)
    created = True
    connect_errno = None
    try:
        handle.connect(("127.0.0.1", LOOPBACK_REFUSED_PORT))
        connected = True
    except OSError as error:
        connected = False
        connect_errno = error.errno
    finally:
        handle.close()
    return {
        "socket_created": created,
        "loopback_connected": connected,
        "loopback_connect_errno": connect_errno,
        "loopback_connect_errno_name": errno.errorcode.get(connect_errno),
    }


attempt("ambient_network_socket", ambient_network)

# --- SC-14-11: ambient subprocess authority, and descendant containment -----


def ambient_subprocess():
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(read_end)
            with open("/proc/self/cgroup", "rb") as handle:
                os.write(write_end, handle.read(4096))
            os.close(write_end)
            os.execv("/bin/true", ["/bin/true"])
        except BaseException:  # noqa: BLE001 - the child must never fall through
            os._exit(70)
        os._exit(71)
    os.close(write_end)
    child_cgroup = os.read(read_end, 4096).decode("utf-8", "replace").strip()
    os.close(read_end)
    _, status = os.waitpid(child, 0)
    return {
        "child_exit_status": status,
        "child_cgroup_line": child_cgroup,
        "child_stayed_in_module_cgroup": child_cgroup.endswith(own[len(CGROUP_MOUNT_POINT) :]),
    }


attempt("ambient_subprocess", ambient_subprocess)

# --- SC-14-05: Core state files ---------------------------------------------


def open_core_state_for_read():
    text = read_text(CORE_STATE_PROBE_PATH)
    return {"sentinel_read": CORE_STATE_SENTINEL in text, "bytes": len(text)}


def open_core_state_for_write():
    descriptor = os.open(CORE_STATE_PROBE_PATH, os.O_WRONLY | os.O_APPEND)
    os.close(descriptor)
    return {"opened_for_write": True, "wrote": False}


attempt("open_core_state_for_read", open_core_state_for_read)
attempt("open_core_state_for_write", open_core_state_for_write)

# --- SC-14-06: service-manager control files --------------------------------


def connect_unix(path):
    def action():
        handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        handle.settimeout(2)
        try:
            handle.connect(path)
        finally:
            handle.close()
        return {"connected": True, "sent_bytes": 0}

    return action


attempt("connect_user_bus_socket", connect_unix(user_bus_socket))
attempt("connect_user_manager_private_socket", connect_unix(user_manager_private_socket))
attempt("connect_system_manager_private_socket", connect_unix(SYSTEM_MANAGER_PRIVATE_SOCKET))

# --- SC-14-07: another process's /proc state --------------------------------

results["core_standin_matches"] = {"outcome": "observed", "errno": None, "errno_name": None, "detail": standins}

if core_pid is None:
    for name in ("read_core_proc_status", "read_core_proc_cmdline", "read_core_proc_environ"):
        record(name, "error", detail="the Core stand-in process could not be identified")
else:
    attempt(
        "read_core_proc_status",
        lambda: read_text("/proc/%d/status" % core_pid, 256).split("\n")[0],
    )
    attempt(
        "read_core_proc_cmdline",
        lambda: read_text("/proc/%d/cmdline" % core_pid, 512).replace("\x00", " ").strip(),
    )

    def read_core_environ():
        raw = read_text("/proc/%d/environ" % core_pid, 8192)
        wanted = CORE_SECRET_ENV_NAME + "=" + CORE_SECRET_ENV_VALUE
        return {"secret_sentinel_read": wanted in raw, "bytes": len(raw)}

    attempt("read_core_proc_environ", read_core_environ)

# --- SC-14-04: signalling Core ----------------------------------------------

if core_pid is None:
    for name in ("signal_core_presence", "signal_core_terminate"):
        record(name, "error", detail="the Core stand-in process could not be identified")
else:
    attempt("signal_core_presence", lambda: os.kill(core_pid, 0) or {"delivered": True})

    def signal_core_terminate():
        os.kill(core_pid, signal.SIGTERM)
        # Give the target a moment, then report whether it is gone.
        time.sleep(0.5)
        return {"target_still_present": os.path.exists("/proc/%d" % core_pid)}

    attempt("signal_core_terminate", signal_core_terminate)

# --- SC-14-01: changing its own control group -------------------------------


def create_child_cgroup():
    path = own + "/" + ESCAPE_CHILD_CGROUP_NAME
    os.mkdir(path)
    limit_written = False
    try:
        with open(path + "/pids.max", "w", encoding="utf-8") as handle:
            handle.write("7")
        limit_written = True
    except OSError:
        limit_written = False
    os.rmdir(path)
    return {"created": True, "configured_new_limit": limit_written, "removed": True}


def create_sibling_cgroup():
    path = parent + "/" + ESCAPE_SIBLING_CGROUP_NAME
    os.mkdir(path)
    return {"created": True, "path": path}


attempt("create_child_cgroup_under_own", create_child_cgroup)
attempt("create_sibling_cgroup_outside_own", create_sibling_cgroup)

# --- SC-14-02: leaving its own control group --------------------------------


def open_for_write_only(path):
    def action():
        descriptor = os.open(path, os.O_WRONLY)
        os.close(descriptor)
        return {"opened_for_write": True, "wrote": False}

    return action


attempt("open_parent_cgroup_procs_for_write", open_for_write_only(parent + "/cgroup.procs"))
attempt("open_user_manager_cgroup_procs_for_write", open_for_write_only(user_manager_cgroup_procs))


def migrate_out_and_back():
    sibling = parent + "/" + ESCAPE_SIBLING_CGROUP_NAME
    if not os.path.isdir(sibling):
        raise RuntimeError("the sibling control group was not created, so no migration was tried")
    with open(sibling + "/cgroup.procs", "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    left = own_cgroup_path()
    with open(own + "/cgroup.procs", "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    returned = own_cgroup_path()
    try:
        os.rmdir(sibling)
        removed = True
    except OSError:
        removed = False
    return {
        "module_cgroup": own,
        "cgroup_after_migration": left,
        "left_module_cgroup": left != own,
        "cgroup_after_return": returned,
        "returned_to_module_cgroup": returned == own,
        "sibling_removed": removed,
    }


attempt("migrate_out_of_module_cgroup", migrate_out_and_back)

# --- SC-14-03: changing its own limits --------------------------------------


def change_own_limit(control_file):
    def action():
        path = own + "/" + control_file
        before = read_text(path).strip()
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("max")
        after = read_text(path).strip()
        restored = None
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(before)
            restored = read_text(path).strip()
        except OSError:
            restored = "restore-failed"
        return {
            "before": before,
            "after_write_max": after,
            "limit_removed": after != before,
            "restored": restored,
        }

    return action


attempt("change_own_memory_max", change_own_limit("memory.max"))
attempt("change_own_pids_max", change_own_limit("pids.max"))

# --- report ------------------------------------------------------------------

report = {
    "uid": uid,
    "own_cgroup": own,
    "parent_cgroup": parent,
    "core_standin_pid": core_pid,
    "attempts": results,
}
sys.stdout.write(json.dumps(report) + "\n")
sys.stdout.flush()
