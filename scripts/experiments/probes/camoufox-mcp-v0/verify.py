#!/usr/bin/env python3
"""Independently verify a frozen Camoufox direct/MCP confirmation run."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from PIL import Image


EXPERIMENT_ID = "camoufox-mcp-v2"
BACKENDS = ("direct-camoufox-python", "mcp-playwright-remote-camoufox")
SEEDS = (2026080901, 2026080902, 2026080903)
INPUT_TEXT = "Dolly-Camoufox-20260809"
REQUIRED_MCP_TOOLS = {
    "browser_navigate",
    "browser_take_screenshot",
    "browser_type",
    "browser_click",
    "browser_evaluate",
    "browser_snapshot",
}
SOURCE_PATHS = {
    "common.py": "scripts/experiments/probes/camoufox-mcp-v0/common.py",
    "direct_case.py": "scripts/experiments/probes/camoufox-mcp-v0/direct_case.py",
    "camoufox_server.py": "scripts/experiments/probes/camoufox-mcp-v0/camoufox_server.py",
    "mcp_case.mjs": "scripts/experiments/probes/camoufox-mcp-v0/mcp_case.mjs",
    "run_experiment.py": "scripts/experiments/probes/camoufox-mcp-v0/run_experiment.py",
    "verify.py": "scripts/experiments/probes/camoufox-mcp-v0/verify.py",
    "fixture/index.html": "scripts/experiments/probes/camoufox-mcp-v0/fixture/index.html",
    "preregistration": "docs/experiments/preregistrations/camoufox-mcp-v2.json",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--preregistration", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def load_jsonl(path: Path, errors: list[str]) -> list[dict[str, Any]]:
    try:
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"{path.name}: invalid JSONL: {error}")
        return []
    if not rows:
        errors.append(f"{path.name}: no records")
        return rows
    if [row.get("sequence") for row in rows] != list(range(1, len(rows) + 1)):
        errors.append(f"{path.name}: sequence is not exact contiguous 1..N")
    return rows


def exactly_one(rows: list[dict[str, Any]], event: str, case: str, errors: list[str]) -> dict[str, Any]:
    matches = [row for row in rows if row.get("event") == event]
    if len(matches) != 1:
        errors.append(f"{case}: expected exactly one {event}, found {len(matches)}")
        return {}
    return matches[0]


def verify_state_rows(rows: list[dict[str, Any]], case: str, errors: list[str]) -> None:
    applied = exactly_one(rows, "state_after_apply", case, errors).get("state", {})
    bottom = exactly_one(rows, "state_after_bottom", case, errors).get("state", {})
    recovered = exactly_one(rows, "state_after_recovery", case, errors).get("state", {})
    if applied.get("inputText") != INPUT_TEXT or applied.get("appliedCount") != 1:
        errors.append(f"{case}: apply state mismatch")
    if applied.get("bottomCount") != 0 or applied.get("recoveredCount") != 0:
        errors.append(f"{case}: apply counters mismatch")
    if bottom.get("inputText") != INPUT_TEXT or bottom.get("appliedCount") != 1:
        errors.append(f"{case}: bottom retained state mismatch")
    if bottom.get("bottomCount") != 1 or bottom.get("recoveredCount") != 0:
        errors.append(f"{case}: bottom counters mismatch")
    if not isinstance(bottom.get("scrollY"), (int, float)) or bottom.get("scrollY", 0) <= 0:
        errors.append(f"{case}: bottom did not require downward scroll")
    expected_recovery = {
        "inputText": INPUT_TEXT,
        "appliedCount": 1,
        "bottomCount": 1,
        "recoveredCount": 1,
    }
    if any(recovered.get(key) != value for key, value in expected_recovery.items()):
        errors.append(f"{case}: recovery state mismatch")
    origins = [value.get("pageTimeOrigin") for value in (applied, bottom, recovered)]
    if not isinstance(origins[0], int) or origins[0] <= 0 or len(set(origins)) != 1:
        errors.append(f"{case}: same page instance was not preserved")


def verify_png(
    path: Path,
    expected_anchors: list[dict[str, Any]],
    case: str,
    errors: list[str],
) -> None:
    try:
        with Image.open(path) as image:
            image.load()
            if image.format != "PNG" or image.size != (800, 600):
                errors.append(f"{case}: {path.name} is not an 800x600 PNG")
                return
            rgba = image.convert("RGBA")
            for anchor in expected_anchors:
                xy = tuple(anchor["xy"])
                expected = tuple(anchor["rgb"])
                actual = rgba.getpixel(xy)[:3]
                if actual != expected:
                    errors.append(f"{case}: {path.name} pixel {xy} is {actual}, expected {expected}")
    except OSError as error:
        errors.append(f"{case}: invalid screenshot {path.name}: {error}")


def verify_screenshots(
    rows: list[dict[str, Any]],
    run_dir: Path,
    backend: str,
    repeat: int,
    oracle: dict[str, Any],
    errors: list[str],
) -> None:
    case = f"{backend}-r{repeat}"
    records = [row for row in rows if row.get("event") == "screenshot_written"]
    by_label = {row.get("label"): row for row in records}
    if len(records) != 2 or set(by_label) != {"top", "bottom"}:
        errors.append(f"{case}: expected exactly top and bottom screenshot records")
        return
    for label, anchors_key in (("top", "topAnchors"), ("bottom", "bottomAnchors")):
        record = by_label[label]
        expected_relative = f"screenshots/{case}-{label}.png"
        if record.get("relativePath") != expected_relative:
            errors.append(f"{case}: {label} screenshot path is not the frozen relative path")
            continue
        path = (run_dir / expected_relative).resolve()
        if run_dir.resolve() not in path.parents or not path.is_file():
            errors.append(f"{case}: {label} screenshot missing or outside run directory")
            continue
        if record.get("byteLength") != path.stat().st_size:
            errors.append(f"{case}: {label} screenshot length mismatch")
        if record.get("sha256") != sha256_file(path):
            errors.append(f"{case}: {label} screenshot digest mismatch")
        verify_png(path, oracle[anchors_key], case, errors)


def verify_mcp_internal_outputs(
    run_dir: Path,
    repeat: int,
    rows: list[dict[str, Any]],
    errors: list[str],
) -> set[str]:
    case = f"mcp-playwright-remote-camoufox-r{repeat}"
    directory = run_dir / "mcp-internal" / f"r{repeat}"
    files = sorted(path for path in directory.glob("*") if path.is_file()) if directory.is_dir() else []
    if len(files) != 2 or any(not re.fullmatch(r"page-[0-9TZ-]+\.png", path.name) for path in files):
        errors.append(f"{case}: MCP internal output must contain exactly two timestamped PNG files")
        return {str(path.relative_to(run_dir)) for path in files}
    internal_hashes = sorted(sha256_file(path) for path in files)
    recorded_hashes = sorted(
        row.get("sha256") for row in rows if row.get("event") == "screenshot_written"
    )
    if internal_hashes != recorded_hashes:
        errors.append(f"{case}: MCP internal PNG bytes differ from retained screenshots")
    return {str(path.relative_to(run_dir)) for path in files}


def verify_direct(rows: list[dict[str, Any]], case: str, errors: list[str]) -> None:
    navigation = exactly_one(rows, "navigation_result", case, errors)
    if navigation.get("status") != 200 or navigation.get("ready") is not True:
        errors.append(f"{case}: direct navigation was not HTTP 200 and ready")
    intentional = exactly_one(rows, "intentional_failure_result", case, errors)
    if intentional.get("observed") is not True or intentional.get("errorType") != "TimeoutError":
        errors.append(f"{case}: direct intentional missing target failure not observed")


def verify_mcp(rows: list[dict[str, Any]], case: str, errors: list[str]) -> None:
    inventory = exactly_one(rows, "mcp_tool_inventory", case, errors)
    names = set(inventory.get("toolNames", []))
    if not REQUIRED_MCP_TOOLS.issubset(names):
        errors.append(f"{case}: required MCP tool inventory missing")
    schemas = inventory.get("schemas", {})
    if set(schemas) != REQUIRED_MCP_TOOLS or not all(isinstance(value, dict) for value in schemas.values()):
        errors.append(f"{case}: required MCP schemas missing")
    calls = [row for row in rows if row.get("event") == "mcp_tool_result"]
    successful_names = {row.get("name") for row in calls if row.get("result", {}).get("isError") is False}
    if not REQUIRED_MCP_TOOLS.issubset(successful_names):
        errors.append(f"{case}: required MCP tools were not all successfully exercised")
    screenshots = [row for row in calls if row.get("name") == "browser_take_screenshot"]
    if len(screenshots) != 2 or any(
        [item.get("type") for item in row.get("result", {}).get("content", [])].count("image") != 1
        for row in screenshots
    ):
        errors.append(f"{case}: MCP screenshot image responses mismatch")
    expected_errors = [
        row for row in calls
        if row.get("name") == "browser_click"
        and row.get("arguments", {}).get("target") == "deliberately-missing"
        and row.get("result", {}).get("isError") is True
    ]
    if len(expected_errors) != 1:
        errors.append(f"{case}: MCP intentional missing target error mismatch")


def verify_case(
    run_dir: Path,
    backend: str,
    repeat: int,
    seed: int,
    fixture_sha: str,
    oracle: dict[str, Any],
    errors: list[str],
) -> None:
    case = f"{backend}-r{repeat}"
    path = run_dir / "raw" / f"{case}.jsonl"
    rows = load_jsonl(path, errors)
    if not rows:
        return
    starts = [row for row in rows if row.get("event") == "case_start"]
    if len(starts) != 1:
        errors.append(f"{case}: expected exactly one case_start")
    else:
        start = starts[0]
        if (start.get("backend"), start.get("repeat"), start.get("seed")) != (backend, repeat, seed):
            errors.append(f"{case}: identity or seed mismatch")
        if start.get("fixtureSha256") != fixture_sha:
            errors.append(f"{case}: fixture digest mismatch")
        proxy = start.get("proxyEnvironment", {})
        if proxy.get("http_proxy") is not None or proxy.get("https_proxy") is not None:
            errors.append(f"{case}: browser case inherited an ambient proxy")
        if proxy.get("NO_PROXY") != "127.0.0.1,localhost" or proxy.get("no_proxy") != "127.0.0.1,localhost":
            errors.append(f"{case}: loopback proxy bypass mismatch")
    if any(row.get("event") == "unexpected_error" for row in rows):
        errors.append(f"{case}: contains unexpected_error")
    end = exactly_one(rows, "case_end", case, errors)
    if rows[-1].get("event") != "case_end":
        errors.append(f"{case}: case_end is not final record")
    if end.get("backend") != backend or end.get("repeat") != repeat:
        errors.append(f"{case}: case_end identity mismatch")
    if end.get("initializationFailure") is not False or end.get("runnerPass") is not True:
        errors.append(f"{case}: runner did not report a complete case")
    if end.get("remainingRecordedProcesses") != []:
        errors.append(f"{case}: recorded process remained live at finalization")
    requests = exactly_one(rows, "local_server_requests", case, errors).get("requestCounts", {})
    if not isinstance(requests.get("success"), int) or requests.get("success", 0) < 1:
        errors.append(f"{case}: local fixture was not served")
    verify_state_rows(rows, case, errors)
    verify_screenshots(rows, run_dir, backend, repeat, oracle, errors)
    if backend == "direct-camoufox-python":
        verify_direct(rows, case, errors)
    else:
        verify_mcp(rows, case, errors)


def write_new(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> int:
    args = parse_args()
    repository = Path(__file__).resolve().parents[4]
    run_dir = args.run_dir.resolve()
    prereg_path = args.preregistration.resolve()
    artifact_root = (repository / "artifacts/experiments/probes/camoufox-mcp-v0").resolve()
    expected_prereg = repository / SOURCE_PATHS["preregistration"]
    if artifact_root not in run_dir.parents or prereg_path != expected_prereg:
        raise ValueError("unexpected run or preregistration path")
    errors: list[str] = []
    prereg = load_json(prereg_path)
    metadata = load_json(run_dir / "run.json")
    if prereg.get("preregistrationId") != EXPERIMENT_ID or prereg.get("status") != "frozen-before-confirmation":
        errors.append("preregistration identity or status mismatch")
    if metadata.get("experimentId") != EXPERIMENT_ID or metadata.get("runId") != run_dir.name:
        errors.append("run metadata identity mismatch")
    if not re.fullmatch(r"[0-9a-f]{40}", str(metadata.get("sourceCommit", ""))):
        errors.append("source commit is not a full Git object id")
    for name, relative_path in SOURCE_PATHS.items():
        actual = sha256_file(repository / relative_path)
        if metadata.get("sourceHashes", {}).get(name) != actual:
            errors.append(f"source hash mismatch: {name}")
        frozen = prereg.get("implementationHashes", {}).get(name)
        if name != "preregistration" and frozen != actual:
            errors.append(f"preregistered implementation hash mismatch: {name}")
    if metadata.get("sourceHashes", {}).get("preregistration") != sha256_file(prereg_path):
        errors.append("preregistration hash mismatch")
    expected_environment = prereg.get("environment", {}).get("exactVersions", {})
    actual_environment = metadata.get("environment", {})
    for key, expected in expected_environment.items():
        actual = actual_environment.get(key)
        if isinstance(actual, dict):
            actual = actual.get("version")
        if actual != expected:
            errors.append(f"environment version mismatch: {key}")
    browser = actual_environment.get("camoufoxBrowser", {})
    expected_browser = prereg.get("environment", {}).get("camoufoxBrowser", {})
    if browser.get("version") != expected_browser.get("version") or browser.get("build") != expected_browser.get("build"):
        errors.append("Camoufox browser version mismatch")
    if browser.get("sha256") != expected_browser.get("releaseArtifactSha256"):
        errors.append("Camoufox release artifact digest mismatch")
    if actual_environment.get("camoufoxExecutableSha256") != expected_browser.get("executableSha256"):
        errors.append("Camoufox executable digest mismatch")

    fixture_sha = sha256_file(repository / SOURCE_PATHS["fixture/index.html"])
    oracle = prereg.get("caseProtocol", {}).get("screenshotOracle", {})
    internal_outputs: set[str] = set()
    for backend in BACKENDS:
        for repeat, seed in enumerate(SEEDS, start=1):
            verify_case(run_dir, backend, repeat, seed, fixture_sha, oracle, errors)
            if backend == "mcp-playwright-remote-camoufox":
                rows = load_jsonl(run_dir / "raw" / f"{backend}-r{repeat}.jsonl", errors)
                internal_outputs.update(verify_mcp_internal_outputs(run_dir, repeat, rows, errors))

    orchestration = load_jsonl(run_dir / "orchestration.jsonl", errors)
    starts = [row for row in orchestration if row.get("event") == "case_process_started"]
    exits = [row for row in orchestration if row.get("event") == "case_process_exit"]
    if len(starts) != 6 or len(exits) != 6 or any(row.get("exitCode") != 0 for row in exits):
        errors.append("orchestration did not record six successful case processes")
    finished = [row for row in orchestration if row.get("event") == "run_finished"]
    if len(finished) != 1 or finished[0].get("repositoryRootMcpOutputAbsent") is not True:
        errors.append("orchestration did not prove repository-root MCP output stayed absent")
    expected_pre_output = {
        "run.json",
        "orchestration.jsonl",
        *{f"raw/{backend}-r{repeat}.jsonl" for backend in BACKENDS for repeat in range(1, 4)},
        *{
            f"screenshots/{backend}-r{repeat}-{label}.png"
            for backend in BACKENDS
            for repeat in range(1, 4)
            for label in ("top", "bottom")
        },
        *internal_outputs,
    }
    actual_pre_output = {
        str(path.relative_to(run_dir))
        for path in run_dir.rglob("*")
        if path.is_file() and path.name not in {"verification.json", "sha256sums.txt"}
    }
    if actual_pre_output != expected_pre_output:
        errors.append("run artifact inventory mismatch")

    result = {
        "experimentId": EXPERIMENT_ID,
        "runId": run_dir.name,
        "valid": not errors,
        "completeCases": 6 if not errors else 0,
        "backendCompleteCases": {
            backend: 3 if not errors else 0 for backend in BACKENDS
        },
        "errors": errors,
        "independentVerifierImportedRunnerCode": False,
    }
    if args.check_only:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not errors else 1

    verification_path = run_dir / "verification.json"
    manifest_path = run_dir / "sha256sums.txt"
    write_new(
        verification_path,
        (json.dumps(result, indent=2, sort_keys=True) + "\n").encode(),
    )
    manifest_lines = []
    for path in sorted(item for item in run_dir.rglob("*") if item.is_file() and item != manifest_path):
        relative = path.relative_to(run_dir).as_posix()
        manifest_lines.append(f"{sha256_file(path)}  {relative}\n")
    write_new(manifest_path, "".join(manifest_lines).encode("ascii"))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
