#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import run_suite


class ResearchLayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = run_suite.run_all(seed=run_suite.DEFAULT_SEED, quick=True)
        run_suite.self_test(cls.bundle)

    def test_reproducible(self) -> None:
        other = run_suite.run_all(seed=run_suite.DEFAULT_SEED, quick=True)
        # Elapsed time is intentionally excluded from reproducibility.
        self.bundle.pop("elapsed_seconds", None)
        other.pop("elapsed_seconds", None)
        self.assertEqual(self.bundle, other)

    def test_association_negative_control(self) -> None:
        result = self.bundle["results"]["association"]
        self.assertGreater(result["metrics"]["normalized"]["precision_at_1"], result["metrics"]["semantic"]["precision_at_1"])
        self.assertGreater(result["temporal_shuffle"]["relative_collapse"], 0.35)

    def test_atomic_context_groups_never_split(self) -> None:
        result = self.bundle["results"]["tensity"]["policies"]
        self.assertEqual(result["group_aware"]["dependency_break_rate"], 0.0)
        self.assertGreater(result["stochastic_tensity"]["dependency_break_rate"], 0.0)

    def test_scheduler_drains_all_inputs(self) -> None:
        result = self.bundle["results"]["scheduler"]["aggregate"]
        self.assertTrue(all(v["unfinished"] == 0.0 for v in result.values()))

    def test_reflection_gate_reduces_regression(self) -> None:
        p = self.bundle["results"]["reflection"]["policies"]
        self.assertLess(p["candidate_pool"]["regression_rate"], p["free_growing_prompt"]["regression_rate"])
        self.assertEqual(p["candidate_pool"]["rollback_supported"], 1.0)

    def test_procedure_gate_rejects_negative_transfer(self) -> None:
        p = self.bundle["results"]["procedural_trajectory"]["policies"]
        self.assertLess(p["trajectory_dtw_with_gate"]["negative_transfer"], p["trajectory_dtw"]["negative_transfer"])

    def test_levelupper_cycle_is_bounded(self) -> None:
        t = self.bundle["results"]["levelupper"]["transport"]
        self.assertLess(t["origin_envelope_dedupe"]["transmissions"], t["naive"]["transmissions"])
        self.assertEqual(t["origin_envelope_dedupe"]["unique_nodes"], 5.0)

    def test_output_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            run_suite.write_outputs(self.bundle, out)
            for name in ["metrics.json", "metrics.csv", "manifest.json", "summary.md", "report.html", "dolly-research-layer-results.zip"]:
                self.assertTrue((out / name).is_file(), name)
            parsed = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
            self.assertEqual(parsed["suite_version"], run_suite.SUITE_VERSION)


if __name__ == "__main__":
    unittest.main(verbosity=2)
