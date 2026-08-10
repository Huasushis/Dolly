#!/usr/bin/env python3
"""Run one direct Camoufox API baseline case and retain raw observations."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np
from camoufox.sync_api import Camoufox
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from common import (
    JsonlRecorder,
    capture_process_identities,
    local_fixture_server,
    process_identity_is_live,
    sha256_file,
    stop_exact_processes,
)


BACKEND = "direct-camoufox-python"
INPUT_TEXT = "Dolly-Camoufox-20260809"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, choices=(1, 2, 3), required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    return parser.parse_args()


def read_state(page: Any) -> dict[str, Any]:
    value = page.evaluate("() => window.__probeRead()")
    if not isinstance(value, dict):
        raise RuntimeError("fixture state was not an object")
    return value


def screenshot_record(recorder: JsonlRecorder, page: Any, path: Path, label: str) -> None:
    if path.exists():
        raise FileExistsError(path)
    started = time.monotonic()
    page.screenshot(path=str(path), type="png", scale="css")
    recorder.record(
        "screenshot_written",
        label=label,
        relativePath=str(path.relative_to(path.parents[1])),
        byteLength=path.stat().st_size,
        sha256=sha256_file(path),
        durationMs=round((time.monotonic() - started) * 1000, 3),
    )


def main() -> int:
    args = parse_args()
    raw_path = args.run_dir / "raw" / f"{BACKEND}-r{args.repeat}.jsonl"
    screenshot_dir = args.run_dir / "screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    recorder = JsonlRecorder(raw_path)
    registered: dict[tuple[int, int], dict[str, int]] = {}
    observations: dict[str, bool] = {}
    initialization_failure = False
    phase = "setup"
    caught: BaseException | None = None

    def register_descendants(reason: str) -> None:
        identities = capture_process_identities(os.getpid())
        for item in identities:
            registered[(item["pid"], item["startTicks"])] = item
        recorder.record("process_tree", reason=reason, identities=identities)

    try:
        random.seed(args.seed)
        np.random.seed(args.seed % (2**32))
        fixture_sha = sha256_file(args.fixture)
        recorder.record(
            "case_start",
            backend=BACKEND,
            repeat=args.repeat,
            seed=args.seed,
            runnerPid=os.getpid(),
            fixtureSha256=fixture_sha,
            proxyEnvironment={
                "http_proxy": os.environ.get("http_proxy"),
                "https_proxy": os.environ.get("https_proxy"),
                "NO_PROXY": os.environ.get("NO_PROXY"),
                "no_proxy": os.environ.get("no_proxy"),
            },
        )
        with local_fixture_server(args.fixture) as (url, request_counts):
            recorder.record("local_server_started", urlOrigin="http://127.0.0.1:<ephemeral>")
            phase = "browser_initialization"
            with Camoufox(
                headless=True,
                os="linux",
                window=(800, 600),
                locale="en-US",
                enable_cache=False,
            ) as browser:
                register_descendants("browser_launched")
                observations["launch"] = True
                context = browser.new_context(viewport={"width": 800, "height": 600})
                page = context.new_page()
                phase = "navigation"
                started = time.monotonic()
                response = page.goto(url, wait_until="load", timeout=30000)
                status = response.status if response is not None else None
                ready = page.locator("#instructions").is_visible()
                recorder.record(
                    "navigation_result",
                    status=status,
                    ready=ready,
                    durationMs=round((time.monotonic() - started) * 1000, 3),
                    requestCounts=dict(request_counts),
                )
                if status != 200 or not ready:
                    raise RuntimeError(f"local navigation failed: status={status}, ready={ready}")
                observations["local_navigation"] = True
                instance_before = read_state(page)["pageTimeOrigin"]

                phase = "scripted_actions"
                screenshot_record(
                    recorder,
                    page,
                    screenshot_dir / f"{BACKEND}-r{args.repeat}-top.png",
                    "top",
                )
                observations["top_screenshot"] = True

                started = time.monotonic()
                page.locator("#probe-input").fill(INPUT_TEXT)
                page.locator("#apply").click()
                applied = read_state(page)
                recorder.record(
                    "state_after_apply",
                    state=applied,
                    durationMs=round((time.monotonic() - started) * 1000, 3),
                )
                if applied["inputText"] != INPUT_TEXT or applied["appliedCount"] != 1:
                    raise RuntimeError(f"unexpected apply state: {json.dumps(applied, sort_keys=True)}")
                observations["click"] = True
                observations["text_input"] = True
                observations["dom_state_change"] = True

                started = time.monotonic()
                page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
                page.locator("#bottom-action").click()
                bottom = read_state(page)
                recorder.record(
                    "state_after_bottom",
                    state=bottom,
                    durationMs=round((time.monotonic() - started) * 1000, 3),
                )
                if bottom["bottomCount"] != 1 or not (bottom["scrollY"] > 0):
                    raise RuntimeError(f"unexpected bottom state: {json.dumps(bottom, sort_keys=True)}")
                observations["downward_scroll"] = True

                screenshot_record(
                    recorder,
                    page,
                    screenshot_dir / f"{BACKEND}-r{args.repeat}-bottom.png",
                    "bottom",
                )
                observations["bottom_screenshot"] = True

                expected_error: BaseException | None = None
                started = time.monotonic()
                try:
                    page.locator("#deliberately-missing").click(timeout=750)
                except PlaywrightTimeoutError as error:
                    expected_error = error
                recorder.record(
                    "intentional_failure_result",
                    observed=expected_error is not None,
                    errorType=type(expected_error).__name__ if expected_error else None,
                    errorMessage=str(expected_error)[:1000] if expected_error else None,
                    durationMs=round((time.monotonic() - started) * 1000, 3),
                )
                if expected_error is None:
                    raise RuntimeError("missing target did not produce a Playwright timeout")
                observations["expected_failure_observed"] = True

                page.locator("#recover").click()
                recovered = read_state(page)
                recorder.record("state_after_recovery", state=recovered)
                if recovered != {
                    "inputText": INPUT_TEXT,
                    "appliedCount": 1,
                    "bottomCount": 1,
                    "recoveredCount": 1,
                    "pageTimeOrigin": instance_before,
                    "scrollY": recovered["scrollY"],
                }:
                    raise RuntimeError(f"unexpected recovery state: {json.dumps(recovered, sort_keys=True)}")
                observations["same_session_recovery"] = True
                register_descendants("before_normal_browser_close")
                context.close()
            phase = "cleanup"
            recorder.record("local_server_requests", requestCounts=dict(request_counts))
    except BaseException as error:  # preserve every unexpected browser/protocol failure
        caught = error
        initialization_failure = phase in ("setup", "browser_initialization")
        recorder.record(
            "unexpected_error",
            phase=phase,
            initializationFailure=initialization_failure,
            errorType=type(error).__name__,
            errorMessage=str(error)[:4000],
            traceback=traceback.format_exc()[:12000],
        )
    finally:
        phase = "cleanup"
        register_descendants("cleanup_scan")
        live = [item for item in registered.values() if process_identity_is_live(item)]
        remaining = stop_exact_processes(live, recorder) if live else []
        observations["clean_close"] = not remaining
        recorder.record(
            "case_end",
            backend=BACKEND,
            repeat=args.repeat,
            initializationFailure=initialization_failure,
            runnerObservations=observations,
            runnerPass=caught is None and all(observations.values()),
            independentPixelValidationPending=True,
            remainingRecordedProcesses=remaining,
        )
        recorder.close()
    return 0 if caught is None else 1


if __name__ == "__main__":
    sys.exit(main())
