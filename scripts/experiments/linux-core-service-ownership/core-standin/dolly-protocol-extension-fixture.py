#!/usr/bin/env python3
"""Extension fixture speaking the real Dolly Extension process protocol.

This is the successor to `extension-fixture.py`. That one spoke
`dolly.experiment.module-protocol/1`, an experiment-only message set, because
`ExtensionProcessHost` could then only spawn its own direct child and the
composition Architecture Decision Record 0009 requires could not be assembled
at all. The host has since gained an attached-process seam, so the experiment
can and must run the real thing.

What "the real thing" means here: this fixture is driven by the shipped
`src/core/extension-process-host.ts`, over the shipped framed JSON transport
(4-byte big-endian length prefix, UTF-8 JSON, descriptors 0 and 1), speaking
the shipped JSON-RPC 2.0 method set at protocol version 3.0:

    Core -> Extension, requests   dolly.initialize
                                  module.create
                                  module.execute
                                  module.stop
                                  dolly.shutdown
    Core -> Extension, notify     dolly.cancel          (no id, no reply)
    Extension -> Core, request    capability.invoke

Every result shape below is a closed object the host validates field by field,
so a shape that drifts is rejected by the host rather than quietly accepted.

The fixture stays a fixture: protocol version 3 requires child commands to be
"fixed local fixtures with finite deadlines", and what the matrix measures is
Core's durability across an interruption, not an Extension's behaviour. What it
must be faithful about is the traffic Core has to survive being interrupted in
the middle of.

Configuration arrives in the `config` value the host passes to
`dolly.initialize` and `module.create`, not in the environment. The host spawns
with an empty environment in its start-command mode, so an environment variable
would exist in one construction mode and not the other; `config` behaves the
same in both.

    config.workload            one of the seven protocol workloads
    config.outputCount         how many output Pages the Run targets
    config.environPath         where to record the inherited environment
    config.descendantPidPath   where to record the descendant's process
                               identifier, for a caller that has no control
                               group to collect it with

`descendantPidPath` exists only for callers outside the matrix. In the matrix
the descendant is collected by whole-control-group termination, which is the
property being measured, and nothing records or signals its identifier. A
protocol check that runs without a control group has no such collector, so it
asks for the identifier and reaps the descendant itself rather than leaving it
behind.

Seven workloads, matching the protocol's list:

    no-output                  a Run that commits nothing
    single-output              one output Block on one Page
    multiple-output-pages      one output Block on several Pages
    processor-loop             a bounded processor loop during the Run
    process-descendant         a descendant that outlives the direct child
    active-capability-handler  a capability request whose Core handler is slow
    unknown-external-effect    a capability request with a real external effect

Capability requests are authorized by the host only while a Run is active, so
every request below is sent between receiving `module.execute` and answering
it. Each workload issues at least one, so boundary 8 is reachable in all seven.
"""

import json
import os
import signal
import struct
import subprocess
import sys
import time

PROTOCOL_VERSION = "3.0"

# Nothing in this fixture may run without bound. The matrix's own case deadline
# is longer, so a fixture that outlives its Core still stops by itself.
FIXED_DEADLINE_SECONDS = 600

# Identity this fixture reports at initialization. The host compares all three
# against the manifest it was constructed with and rejects a mismatch, so these
# must agree with the manifest the harness builds.
EXTENSION_ID = "dolly-test-experiment-extension"
PACKAGE_VERSION = "1.0.0"
MODULE_KIND = "reactive"

CONTENT_SCHEMA = "dolly.experiment.text/1"


def fail(message):
    sys.stderr.write("extension-fixture: " + message + "\n")
    sys.stderr.flush()
    os._exit(70)


# ---------------------------------------------------------------------------
# Framing: the wire format of src/core/framed-json-channel.ts
# ---------------------------------------------------------------------------


def read_exactly(count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = os.read(0, remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame():
    header = read_exactly(4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length < 2 or length > 4 * 1024 * 1024:
        fail("inbound frame length is out of range")
    body = read_exactly(length)
    if body is None:
        fail("input ended mid-frame")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        fail("inbound frame is not closed UTF-8 JSON")


def write_frame(value):
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload = struct.pack(">I", len(body)) + body
    written = 0
    while written < len(payload):
        written += os.write(1, payload[written:])


def reply(request_id, result):
    write_frame({"jsonrpc": "2.0", "id": request_id, "result": result})


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


class Session:
    def __init__(self):
        self.session_id = None
        self.module_id = None
        self.module_generation_id = None
        self.config = {}
        # capabilityType -> handle object, exactly as the host issued it.
        self.handles = {}
        self.next_request = 0
        self.cancelled_requests = set()
        self.descendant = None

    @property
    def workload(self):
        return self.config.get("workload", "single-output")

    @property
    def output_count(self):
        value = self.config.get("outputCount")
        return value if isinstance(value, int) else 1


def record_environment(session):
    """Writes the environment this process actually inherited.

    Invariant INV-09 is a statement about what `execve` handed this process.
    `os.environ` is not that: CPython adds to its own environment during
    start-up, so comparing it with Core's declaration would measure the
    interpreter rather than the inheritance. `/proc/self/environ` is the block
    the kernel placed on the stack at `execve` time and no later `setenv`
    changes it. The interpreter's own view is written beside it for diagnosis.
    """
    path = session.config.get("environPath")
    if not isinstance(path, str) or not path:
        return
    inherited = {}
    try:
        with open("/proc/self/environ", "rb") as handle:
            for entry in handle.read().split(b"\0"):
                if not entry:
                    continue
                name, separator, value = entry.decode("utf-8", "replace").partition("=")
                if separator:
                    inherited[name] = value
    except OSError:
        inherited = {"__unreadable__": "/proc/self/environ"}
    for target, payload in ((path, inherited), (path + ".runtime", dict(os.environ))):
        try:
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            # The environment record is evidence, not control flow. A Run that
            # cannot write it still runs; the case reports the missing file.
            pass


# ---------------------------------------------------------------------------
# Workload behaviour
# ---------------------------------------------------------------------------


def start_descendant():
    """A descendant that outlives its parent unless the whole group is stopped.

    `start_new_session` puts it in its own process group, so a caller that
    terminated the direct child's process group would miss it. That is exactly
    the failure whole-control-group termination prevents.
    """
    return subprocess.Popen(
        ["/bin/sleep", "300"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env={},
    )


def process_start_ticks(pid):
    """Field 22 of `/proc/<pid>/stat`: the process's start time in clock ticks.

    A process identifier alone is not an identity — Linux reuses it — which is
    the same reason Architecture Decision Record 0009 refuses to accept a
    recovered identifier as evidence. Pairing the identifier with the start
    time does identify one process, because the kernel will not produce the
    same pair twice. The field is read from the end of the line so a command
    name containing spaces or parentheses cannot shift the offset.
    """
    try:
        with open("/proc/" + str(pid) + "/stat", "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return None
    tail = text[text.rfind(")") + 1 :].split()
    # After the closing parenthesis the fields are 3..52, so field 22 is index 19.
    return tail[19] if len(tail) > 19 else None


def record_descendant(session):
    """Records the descendant's identity when the caller asked for it.

    Only a caller with no control group asks. The matrix does not, because
    whether the descendant survives anything but whole-control-group
    termination is the thing it measures.

    The file's **first line is the process identifier alone**, so a reader that
    parses one integer keeps working. The second line is the start time from
    `/proc/<pid>/stat`; a reader that wants an identity rather than a number
    checks both before it signals anything.
    """
    path = session.config.get("descendantPidPath")
    if not isinstance(path, str) or not path or session.descendant is None:
        return
    pid = session.descendant.pid
    started = process_start_ticks(pid)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(pid) + "\n")
            if started is not None:
                handle.write(started + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        pass


def burn_processor(seconds):
    deadline = time.monotonic() + seconds
    value = 0
    while time.monotonic() < deadline:
        for _ in range(20000):
            value = (value * 31 + 7) & 0xFFFFFFFF
    return value


def invoke_capability(session, capability_type, operation, arguments, key, module_job_id, run_id):
    """Sends one `capability.invoke` and waits for its response.

    While waiting, `dolly.cancel` may arrive; it is a notification and is
    recorded rather than answered. Nothing else may arrive: the host sends no
    other request while one Run is executing.
    """
    handle = session.handles.get(capability_type)
    if handle is None:
        fail("Core granted no " + capability_type + " capability")
    session.next_request += 1
    request_id = "cap-" + str(session.next_request)
    write_frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "capability.invoke",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "sessionId": session.session_id,
                "handle": handle,
                "operation": operation,
                "arguments": arguments,
                "moduleJobId": module_job_id,
                "runId": run_id,
                "idempotencyKey": key,
            },
        }
    )
    while True:
        frame = read_frame()
        if frame is None:
            # Core went away while the request was open. The fixture never
            # decides a capability outcome for itself, so it just stops.
            os._exit(0)
        if isinstance(frame.get("method"), str):
            if frame.get("method") == "dolly.cancel":
                handle_cancel(session, frame.get("params"))
                continue
            fail("Core sent an unexpected request while a capability was open")
        if frame.get("id") != request_id:
            fail("capability response identifier does not match the request")
        if "error" in frame and frame.get("error") is not None:
            return {"error": frame["error"]}
        return {"value": frame.get("result", {}).get("value")}


def handle_cancel(session, params):
    if isinstance(params, dict) and isinstance(params.get("requestId"), str):
        session.cancelled_requests.add(params["requestId"])


def run_workload(session, params):
    """Performs the workload and returns the `result` value of `module.execute`.

    The returned value is a `dolly.module-result/1`, the shape the reactive
    runtime already defines, so Core consumes it without translation.
    """
    workload = session.workload
    run_id = params["runId"]
    module_job_id = params["moduleJobId"]

    # The descendant is created before the first capability request, and that
    # ordering is what the boundaries below can observe.
    #
    # It used to be created after that request. Because the request blocks until
    # Core replies, and an interruption at a boundary at or before 8 freezes Core
    # before it replies, the descendant was never created in those cases at all.
    # Every `process-descendant` case at boundary 8 or earlier was therefore
    # measuring a Module with no descendant, while reporting the same passed or
    # failed verdict as the cases that had one. The protocol asks for each
    # interruption point to be exercised at least once with a process
    # descendant, and for boundaries 4-after through 8 that was not happening.
    #
    # Creating it first costs nothing: no boundary sits between the start of
    # `module.execute` and this point.
    if workload == "process-descendant":
        session.descendant = start_descendant()
        record_descendant(session)

    # Every workload exercises boundary 8 at least once. The two workloads with
    # their own capability behaviour issue a second request below.
    invoke_capability(
        session,
        "structured-log",
        "write",
        {"level": "info", "message": "module run started", "runId": run_id},
        run_id + "-log-1",
        module_job_id,
        run_id,
    )

    if workload == "processor-loop":
        burn_processor(2.0)
    elif workload == "active-capability-handler":
        invoke_capability(
            session,
            "structured-log",
            "write-slow",
            {"level": "info", "message": "slow handler", "runId": run_id},
            run_id + "-log-2",
            module_job_id,
            run_id,
        )
    elif workload == "unknown-external-effect":
        invoke_capability(
            session,
            "external-effect",
            "emit",
            {"runId": run_id, "payload": "external effect with an unknown outcome"},
            run_id + "-effect-1",
            module_job_id,
            run_id,
        )

    if workload == "no-output":
        return {"schemaVersion": "dolly.module-result/1"}
    return {
        "schemaVersion": "dolly.module-result/1",
        "blockProposal": {
            "payload": {
                "schema": CONTENT_SCHEMA,
                "value": {"text": "output of " + workload + " for run " + run_id},
            }
        },
    }


# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------


def on_initialize(session, request_id, params):
    session.session_id = params.get("sessionId")
    config = params.get("config")
    session.config = config if isinstance(config, dict) else {}
    for descriptor in params.get("capabilities") or []:
        capability_type = descriptor.get("capabilityType")
        if isinstance(capability_type, str):
            session.handles[capability_type] = descriptor.get("handle")
    record_environment(session)
    reply(
        request_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session.session_id,
            "extensionId": EXTENSION_ID,
            "packageVersion": PACKAGE_VERSION,
            "moduleKinds": [MODULE_KIND],
        },
    )


def on_module_create(session, request_id, params):
    session.module_id = params.get("moduleId")
    session.module_generation_id = params.get("moduleGenerationId")
    config = params.get("config")
    if isinstance(config, dict):
        session.config = config
    reply(
        request_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session.session_id,
            "moduleId": session.module_id,
            "moduleGenerationId": session.module_generation_id,
        },
    )


def on_module_execute(session, request_id, params):
    result = run_workload(session, params)
    reply(
        request_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session.session_id,
            "moduleId": session.module_id,
            "moduleGenerationId": session.module_generation_id,
            "runId": params.get("runId"),
            "result": result,
        },
    )


def on_module_stop(session, request_id, _params):
    reply(
        request_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session.session_id,
            "stopped": True,
        },
    )


def on_shutdown(session, request_id, _params):
    reply(
        request_id,
        {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": session.session_id,
            "stopped": True,
        },
    )
    # The descendant is deliberately not stopped: whether it is still alive is
    # what whole-control-group termination is measured against.
    return "shutdown"


DISPATCH = {
    "dolly.initialize": on_initialize,
    "module.create": on_module_create,
    "module.execute": on_module_execute,
    "module.stop": on_module_stop,
    "dolly.shutdown": on_shutdown,
}


def main():
    signal.alarm(FIXED_DEADLINE_SECONDS)
    session = Session()
    while True:
        frame = read_frame()
        if frame is None:
            return 0
        method = frame.get("method")
        if not isinstance(method, str):
            fail("Core sent a response to a request this fixture never made")
        params = frame.get("params")
        if not isinstance(params, dict):
            params = {}
        request_id = frame.get("id")
        if request_id is None:
            if method == "dolly.cancel":
                handle_cancel(session, params)
                continue
            fail("Core sent an unknown notification: " + method)
        handler = DISPATCH.get(method)
        if handler is None:
            fail("Core sent an unknown request: " + method)
        if handler(session, request_id, params) == "shutdown":
            # Core has acknowledged shutdown; it closes the channel next. The
            # fixture keeps reading so the exit is driven by Core, not guessed.
            continue
    return 0


sys.exit(main())
