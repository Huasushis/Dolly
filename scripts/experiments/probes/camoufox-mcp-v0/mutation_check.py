#!/usr/bin/env python3
"""Check that independent Camoufox verification rejects targeted counterexamples."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def rewrite_json(path: Path, mutate: Callable[[dict], None]) -> None:
    value = json.loads(path.read_text())
    mutate(value)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def rewrite_jsonl(path: Path, mutate: Callable[[list[dict]], None]) -> None:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    mutate(rows)
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))


def replace_applied_count(run: Path) -> None:
    path = run / "raw/direct-camoufox-python-r1.jsonl"
    def mutate(rows: list[dict]) -> None:
        next(row for row in rows if row.get("event") == "state_after_apply")["state"]["appliedCount"] = 2
    rewrite_jsonl(path, mutate)


def replace_pixel_and_integrity_metadata(run: Path) -> None:
    relative = Path("screenshots/mcp-playwright-remote-camoufox-r1-top.png")
    path = run / relative
    original_digest = hashlib.sha256(path.read_bytes()).hexdigest()
    internal = next(
        item for item in (run / "mcp-internal/r1").glob("*.png")
        if hashlib.sha256(item.read_bytes()).hexdigest() == original_digest
    )
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        rgba.putpixel((10, 10), (19, 52, 86, 255))
        rgba.save(path, format="PNG")
    internal.write_bytes(path.read_bytes())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    raw = run / "raw/mcp-playwright-remote-camoufox-r1.jsonl"
    def mutate(rows: list[dict]) -> None:
        row = next(
            item for item in rows
            if item.get("event") == "screenshot_written" and item.get("label") == "top"
        )
        row["byteLength"] = path.stat().st_size
        row["sha256"] = digest
    rewrite_jsonl(raw, mutate)


def remove_required_tool(run: Path) -> None:
    path = run / "raw/mcp-playwright-remote-camoufox-r2.jsonl"
    def mutate(rows: list[dict]) -> None:
        row = next(item for item in rows if item.get("event") == "mcp_tool_inventory")
        row["toolNames"].remove("browser_evaluate")
        del row["schemas"]["browser_evaluate"]
    rewrite_jsonl(path, mutate)


def add_remaining_process(run: Path) -> None:
    path = run / "raw/direct-camoufox-python-r2.jsonl"
    def mutate(rows: list[dict]) -> None:
        row = next(item for item in rows if item.get("event") == "case_end")
        row["remainingRecordedProcesses"] = [{"pid": 999999, "startTicks": 1}]
    rewrite_jsonl(path, mutate)


def alter_source_hash(run: Path) -> None:
    rewrite_json(run / "run.json", lambda value: value["sourceHashes"].__setitem__("mcp_case.mjs", "0" * 64))


def add_extra_artifact(run: Path) -> None:
    (run / "unexpected.txt").write_text("not preregistered\n")


def remove_internal_output(run: Path) -> None:
    next((run / "mcp-internal/r2").glob("*.png")).unlink()


def falsify_root_output_proof(run: Path) -> None:
    path = run / "orchestration.jsonl"
    def mutate(rows: list[dict]) -> None:
        row = next(item for item in rows if item.get("event") == "run_finished")
        row["repositoryRootMcpOutputAbsent"] = False
    rewrite_jsonl(path, mutate)


def main() -> int:
    args = parse_args()
    repository = Path(__file__).resolve().parents[4]
    source = repository / "artifacts/experiments/probes/camoufox-mcp-v0/confirmation-v2-20260810a"
    verifier = repository / "scripts/experiments/probes/camoufox-mcp-v0/verify.py"
    preregistration = repository / "docs/experiments/preregistrations/camoufox-mcp-v2.json"
    scratch_parent = repository / "artifacts/experiments/probes/camoufox-mcp-v0"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="camoufox-verifier-mutations-", dir=scratch_parent))
    mutations = {
        "action-state": replace_applied_count,
        "pixel-with-updated-hash": replace_pixel_and_integrity_metadata,
        "required-tool": remove_required_tool,
        "remaining-process": add_remaining_process,
        "source-hash": alter_source_hash,
        "extra-artifact": add_extra_artifact,
        "missing-mcp-internal-output": remove_internal_output,
        "root-output-proof": falsify_root_output_proof,
    }
    results: dict[str, bool] = {}
    try:
        for name, mutate in mutations.items():
            target = scratch / name / source.name
            target.parent.mkdir(parents=True)
            shutil.copytree(source, target)
            mutate(target)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(verifier),
                    "--check-only",
                    "--run-dir", str(target),
                    "--preregistration", str(preregistration),
                ],
                cwd=repository,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            results[name] = completed.returncode != 0
        result = {
            "allRejected": all(results.values()),
            "mutations": results,
            "sourceRun": source.name,
            "mutationCheckerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "verifierSha256": hashlib.sha256(verifier.read_bytes()).hexdigest(),
        }
        rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
        print(rendered, end="")
        if args.output is not None:
            output = args.output.resolve()
            artifact_root = (repository / "artifacts/experiments/probes/camoufox-mcp-v0").resolve()
            if artifact_root not in output.parents:
                raise ValueError("mutation output must be below the Camoufox artifact root")
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x", encoding="utf-8") as stream:
                stream.write(rendered)
                stream.flush()
                os.fsync(stream.fileno())
        return 0 if all(results.values()) else 1
    finally:
        if scratch.parent == scratch_parent and scratch.name.startswith("camoufox-verifier-mutations-"):
            shutil.rmtree(scratch)


if __name__ == "__main__":
    sys.exit(main())
