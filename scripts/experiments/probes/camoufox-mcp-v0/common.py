"""Shared recording and local HTTP helpers for the Camoufox capability probe."""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class JsonlRecorder:
    """Append immutable, flushed observations to one case's JSON Lines file."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._stream = path.open("x", encoding="utf-8")
        self._start = time.monotonic()
        self._sequence = 0

    def record(self, event: str, **fields: Any) -> None:
        self._sequence += 1
        row = {
            "sequence": self._sequence,
            "wallTimeUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "monotonicMsSinceStart": round((time.monotonic() - self._start) * 1000, 3),
            "event": event,
            **fields,
        }
        self._stream.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
        self._stream.flush()
        os.fsync(self._stream.fileno())

    def close(self) -> None:
        self._stream.close()


def process_start_ticks(pid: int) -> int | None:
    """Return Linux process start ticks, which disambiguate reused process IDs."""

    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split()
        return int(fields[21])
    except (FileNotFoundError, IndexError, PermissionError, ValueError):
        return None


def descendant_pids(root_pid: int) -> list[int]:
    """List current descendants using Linux /proc parent relationships."""

    parent_to_children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().split()
            pid = int(fields[0])
            parent = int(fields[3])
        except (FileNotFoundError, IndexError, PermissionError, ValueError):
            continue
        parent_to_children.setdefault(parent, []).append(pid)

    found: list[int] = []
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        for child in sorted(parent_to_children.get(parent, [])):
            found.append(child)
            pending.append(child)
    return found


def capture_process_identities(root_pid: int) -> list[dict[str, int]]:
    identities = []
    for pid in descendant_pids(root_pid):
        start_ticks = process_start_ticks(pid)
        if start_ticks is not None:
            identities.append({"pid": pid, "startTicks": start_ticks})
    return identities


def process_identity_is_live(identity: dict[str, int]) -> bool:
    return process_start_ticks(identity["pid"]) == identity["startTicks"]


def stop_exact_processes(
    identities: list[dict[str, int]], recorder: JsonlRecorder, grace_seconds: float = 3.0
) -> list[dict[str, int]]:
    """Stop only recorded process identities, validating start ticks before signals."""

    unique = {(item["pid"], item["startTicks"]): item for item in identities}
    ordered = list(unique.values())
    for identity in reversed(ordered):
        if not process_identity_is_live(identity):
            continue
        os.kill(identity["pid"], signal.SIGTERM)
        recorder.record("process_signal", signal="SIGTERM", identity=identity)

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if not any(process_identity_is_live(item) for item in ordered):
            return []
        time.sleep(0.05)

    for identity in reversed(ordered):
        if not process_identity_is_live(identity):
            continue
        os.kill(identity["pid"], signal.SIGKILL)
        recorder.record("process_signal", signal="SIGKILL", identity=identity)
    time.sleep(0.1)
    return [item for item in ordered if process_identity_is_live(item)]


@contextlib.contextmanager
def local_fixture_server(fixture: Path) -> Iterator[tuple[str, dict[str, int]]]:
    """Serve only the frozen fixture on an ephemeral loopback port."""

    body = fixture.read_bytes()
    request_counts = {"success": 0, "notFound": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            if self.path.split("?", 1)[0] in ("/", "/index.html"):
                request_counts["success"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            request_counts["notFound"] += 1
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, name="fixture-http", daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/index.html", request_counts
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
