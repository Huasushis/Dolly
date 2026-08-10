#!/usr/bin/env python3
"""Run the frozen direct and MCP Camoufox confirmation matrix."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.metadata
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


EXPERIMENT_ID = "camoufox-mcp-v2"
BACKENDS = ("direct-camoufox-python", "mcp-playwright-remote-camoufox")
SEEDS = (2026080901, 2026080902, 2026080903)
SOURCE_NAMES = (
    "common.py",
    "direct_case.py",
    "camoufox_server.py",
    "mcp_case.mjs",
    "run_experiment.py",
    "verify.py",
    "fixture/index.html",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--tool-root", type=Path, required=True)
    parser.add_argument("--preregistration", type=Path, required=True)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new_json(path: Path, value: Any) -> None:
    data = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Recorder:
    def __init__(self, path: Path) -> None:
        self._stream = path.open("x", encoding="utf-8")
        self._sequence = 0
        self._started = time.monotonic()

    def record(self, event: str, **fields: Any) -> None:
        self._sequence += 1
        row = {
            "sequence": self._sequence,
            "wallTimeUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "monotonicMsSinceStart": round((time.monotonic() - self._started) * 1000, 3),
            "event": event,
            **fields,
        }
        self._stream.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
        self._stream.flush()
        os.fsync(self._stream.fileno())

    def close(self) -> None:
        self._stream.close()


def process_start_ticks(pid: int) -> int | None:
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().split()[21])
    except (FileNotFoundError, IndexError, PermissionError, ValueError):
        return None


def exact_descendants(root_pid: int) -> list[dict[str, int]]:
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().split()
            pid, parent = int(fields[0]), int(fields[3])
        except (FileNotFoundError, IndexError, PermissionError, ValueError):
            continue
        children.setdefault(parent, []).append(pid)
    identities: list[dict[str, int]] = []
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        for pid in sorted(children.get(parent, [])):
            ticks = process_start_ticks(pid)
            if ticks is not None:
                identities.append({"pid": pid, "startTicks": ticks})
            pending.append(pid)
    return identities


def identity_live(identity: dict[str, int]) -> bool:
    return process_start_ticks(identity["pid"]) == identity["startTicks"]


def stop_exact(identities: list[dict[str, int]], recorder: Recorder) -> None:
    unique = {(item["pid"], item["startTicks"]): item for item in identities}
    ordered = list(unique.values())[::-1]
    for identity in ordered:
        if identity_live(identity):
            os.kill(identity["pid"], signal.SIGTERM)
            recorder.record("orchestrator_process_signal", signal="SIGTERM", identity=identity)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and any(identity_live(item) for item in ordered):
        time.sleep(0.05)
    for identity in ordered:
        if identity_live(identity):
            os.kill(identity["pid"], signal.SIGKILL)
            recorder.record("orchestrator_process_signal", signal="SIGKILL", identity=identity)


def read_node_package(tool_root: Path, name: str) -> dict[str, Any]:
    package = tool_root / "node" / "node_modules" / name / "package.json"
    value = json.loads(package.read_text())
    return {"version": value["version"], "packageJsonSha256": sha256_file(package)}


def build_environment(tool_root: Path) -> dict[str, str]:
    root = str(tool_root)
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": f"{root}/home",
        "XDG_CACHE_HOME": f"{root}/cache",
        "TMPDIR": f"{root}/tmp",
        "npm_config_cache": f"{root}/npm-cache",
        "PIP_CACHE_DIR": f"{root}/pip-cache",
        "PYTHONPYCACHEPREFIX": "/home/ubuntu/codex-dolly/.tmp/camoufox-pycache",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def run_case(
    command: list[str],
    environment: dict[str, str],
    backend: str,
    repeat: int,
    recorder: Recorder,
) -> int:
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    identity = {"pid": process.pid, "startTicks": process_start_ticks(process.pid)}
    recorder.record("case_process_started", backend=backend, repeat=repeat, identity=identity)
    try:
        stdout, stderr = process.communicate(timeout=90)
    except subprocess.TimeoutExpired:
        identities = [identity, *exact_descendants(process.pid)]
        stop_exact([item for item in identities if item["startTicks"] is not None], recorder)
        stdout, stderr = process.communicate(timeout=5)
        recorder.record(
            "case_process_timeout",
            backend=backend,
            repeat=repeat,
            stdout=stdout[-4000:],
            stderr=stderr[-4000:],
        )
        return 124
    recorder.record(
        "case_process_exit",
        backend=backend,
        repeat=repeat,
        exitCode=process.returncode,
        stdout=stdout[-4000:],
        stderr=stderr[-4000:],
    )
    return int(process.returncode)


def initialization_failed(raw_path: Path) -> bool:
    rows = [json.loads(line) for line in raw_path.read_text().splitlines() if line.strip()]
    ends = [row for row in rows if row.get("event") == "case_end"]
    return len(ends) == 1 and ends[0].get("initializationFailure") is True


def main() -> int:
    args = parse_args()
    repository = Path(__file__).resolve().parents[4]
    experiment_dir = Path(__file__).resolve().parent
    artifact_root = (repository / "artifacts/experiments/probes/camoufox-mcp-v0").resolve()
    run_dir = args.run_dir.resolve()
    tool_root = args.tool_root.resolve()
    preregistration = args.preregistration.resolve()
    if artifact_root not in run_dir.parents or run_dir.exists():
        raise ValueError("run directory must be a new child of the Camoufox artifact root")
    if tool_root != Path("/home/ubuntu/codex-dolly/.tools/camoufox-mcp-v0"):
        raise ValueError("unexpected tool root")
    if preregistration != repository / "docs/experiments/preregistrations/camoufox-mcp-v2.json":
        raise ValueError("unexpected preregistration")
    escaped_mcp_output = repository / ".playwright-mcp"
    if escaped_mcp_output.exists():
        raise ValueError("repository-root .playwright-mcp must be absent before confirmation")

    run_dir.mkdir(parents=True, mode=0o700)
    (run_dir / "raw").mkdir(mode=0o700)
    (run_dir / "screenshots").mkdir(mode=0o700)
    recorder = Recorder(run_dir / "orchestration.jsonl")
    fixture = experiment_dir / "fixture/index.html"
    browser_root = tool_root / "cache/camoufox/browsers/official/152.0.4-beta.28-924f3109"
    browser_metadata = json.loads((browser_root / "version.json").read_text())
    source_paths = {name: experiment_dir / name for name in SOURCE_NAMES}
    source_paths["preregistration"] = preregistration
    metadata = {
        "experimentId": EXPERIMENT_ID,
        "runId": run_dir.name,
        "createdAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repository, text=True
        ).strip(),
        "sourceHashes": {name: sha256_file(path) for name, path in sorted(source_paths.items())},
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            "camoufoxPython": importlib.metadata.version("camoufox"),
            "pythonPlaywright": importlib.metadata.version("playwright"),
            "pillow": importlib.metadata.version("pillow"),
            "numpy": importlib.metadata.version("numpy"),
            "mcpSdk": read_node_package(tool_root, "@modelcontextprotocol/sdk"),
            "playwrightMcp": read_node_package(tool_root, "@playwright/mcp"),
            "mcpPlaywright": read_node_package(tool_root, "playwright"),
            "mcpPlaywrightCore": read_node_package(tool_root, "playwright-core"),
            "toolDependencyLockSha256": sha256_file(tool_root / "node/package-lock.json"),
            "camoufoxBrowser": browser_metadata,
            "camoufoxExecutableSha256": sha256_file(browser_root / "camoufox-bin"),
        },
        "casePlan": [
            {"backend": backend, "repeat": repeat, "seed": SEEDS[repeat - 1]}
            for backend in BACKENDS
            for repeat in range(1, 4)
        ],
    }
    write_new_json(run_dir / "run.json", metadata)
    recorder.record("run_started", experimentId=EXPERIMENT_ID, runId=run_dir.name)
    environment = build_environment(tool_root)
    python = str(tool_root / "venv/bin/python")
    node = "/usr/bin/node"
    overall_ok = True
    try:
        for backend in BACKENDS:
            consecutive_initialization_failures = 0
            for repeat, seed in enumerate(SEEDS, start=1):
                if backend == "direct-camoufox-python":
                    command = [
                        python,
                        str(experiment_dir / "direct_case.py"),
                        "--repeat", str(repeat),
                        "--seed", str(seed),
                        "--run-dir", str(run_dir),
                        "--fixture", str(fixture),
                    ]
                else:
                    command = [
                        node,
                        str(experiment_dir / "mcp_case.mjs"),
                        "--repeat", str(repeat),
                        "--seed", str(seed),
                        "--run-dir", str(run_dir),
                        "--fixture", str(fixture),
                        "--tool-root", str(tool_root),
                        "--python", python,
                    ]
                code = run_case(command, environment, backend, repeat, recorder)
                raw_path = run_dir / "raw" / f"{backend}-r{repeat}.jsonl"
                if code == 0:
                    consecutive_initialization_failures = 0
                    continue
                overall_ok = False
                if raw_path.exists() and initialization_failed(raw_path):
                    consecutive_initialization_failures += 1
                else:
                    consecutive_initialization_failures = 0
                if consecutive_initialization_failures >= 2:
                    recorder.record("backend_stopped", backend=backend, reason="two-initialization-failures")
                    break
        if escaped_mcp_output.exists():
            overall_ok = False
            recorder.record("escaped_mcp_output", path=".playwright-mcp")
        recorder.record(
            "run_finished",
            allCaseProcessesExitedZero=overall_ok,
            repositoryRootMcpOutputAbsent=not escaped_mcp_output.exists(),
        )
    finally:
        recorder.close()
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
