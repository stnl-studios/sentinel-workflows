#!/usr/bin/env python3
"""Verify canonical runtime dependencies and measured instruction budgets."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = (
    ROOT
    / "skills/stnl-spec-lifecycle-manager/maintenance/runtime-context-budget.json"
)
SKILL = "skills/stnl-spec-lifecycle-manager/SKILL.md"
MODES = "skills/stnl-spec-lifecycle-manager/references/modes.md"
WORKSPACE = "skills/stnl-spec-lifecycle-manager/references/spec-workspace.md"
SCHEMA = "skills/stnl-spec-lifecycle-manager/references/spec-schema.md"
GATES = "skills/stnl-spec-lifecycle-manager/references/readiness-gates.md"
IDS = "skills/stnl-spec-lifecycle-manager/references/canonical-ids.md"
CLOSE_POLICY = "skills/stnl-spec-lifecycle-manager/references/close-policy.md"
EXPECTED_RUNTIME = {
    "INIT_DRAFT": [SKILL, MODES, WORKSPACE, SCHEMA],
    "INIT_READY": [SKILL, MODES, WORKSPACE, SCHEMA, GATES, IDS],
    "RESUME_FOCUSED": [SKILL, MODES, WORKSPACE],
    "READINESS_LOCAL": [SKILL, MODES, GATES],
    "READINESS_GLOBAL": [SKILL, MODES, GATES],
    "CLOSE": [SKILL, MODES, GATES, CLOSE_POLICY],
}


def metrics(blobs: list[bytes]) -> dict[str, int]:
    return {
        "words": sum(len(blob.decode("utf-8").split()) for blob in blobs),
        "bytes": sum(len(blob) for blob in blobs),
    }


class RuntimeContextBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_manifest_has_canonical_dependencies_and_no_maintenance_runtime(self) -> None:
        self.assertEqual(self.manifest["schema_version"], 1)
        self.assertEqual(set(self.manifest["modes"]), set(EXPECTED_RUNTIME))
        maintenance = set(self.manifest["maintenance_only"])
        for mode, expected in EXPECTED_RUNTIME.items():
            declared = self.manifest["modes"][mode]["runtime_files"]
            self.assertEqual(declared, expected, mode)
            self.assertEqual(len(declared), len(set(declared)), mode)
            self.assertTrue(maintenance.isdisjoint(declared), mode)
            self.assertFalse(any("/maintenance/" in path for path in declared), mode)
            self.assertFalse(any(path.endswith("token-economy.md") for path in declared), mode)
            for relative in declared:
                self.assertTrue((ROOT / relative).is_file(), relative)

        for mode in ("READINESS_LOCAL", "READINESS_GLOBAL"):
            declared = set(self.manifest["modes"][mode]["runtime_files"])
            self.assertNotIn(SCHEMA, declared)
            self.assertNotIn(IDS, declared)
        self.assertNotIn(SCHEMA, self.manifest["modes"]["CLOSE"]["runtime_files"])
        self.assertNotIn(IDS, self.manifest["modes"]["CLOSE"]["runtime_files"])

    def test_recorded_baseline_matches_the_prechange_revision(self) -> None:
        revision = self.manifest["baseline_revision"]
        for mode, contract in self.manifest["modes"].items():
            baseline = contract["baseline"]
            blobs = []
            for relative in baseline["files"]:
                completed = subprocess.run(
                    ["git", "show", f"{revision}:{relative}"],
                    cwd=ROOT,
                    check=False,
                    capture_output=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8"))
                blobs.append(completed.stdout)
            self.assertEqual(metrics(blobs), {"words": baseline["words"], "bytes": baseline["bytes"]}, mode)

    def test_current_runtime_is_within_small_explicit_ceilings(self) -> None:
        print("\nMODE FILES WORDS BYTES WORD_DELTA BYTE_DELTA")
        for mode, contract in self.manifest["modes"].items():
            current = metrics([(ROOT / path).read_bytes() for path in contract["runtime_files"]])
            baseline = contract["baseline"]
            ceilings = contract["ceilings"]
            self.assertLessEqual(current["words"], ceilings["words"], mode)
            self.assertLessEqual(current["bytes"], ceilings["bytes"], mode)
            self.assertLessEqual(ceilings["words"], baseline["words"], mode)
            self.assertLessEqual(ceilings["bytes"], baseline["bytes"], mode)
            print(
                mode,
                len(contract["runtime_files"]),
                current["words"],
                current["bytes"],
                current["words"] - baseline["words"],
                current["bytes"] - baseline["bytes"],
            )

    def test_required_reductions_hold_for_words_and_bytes(self) -> None:
        for mode, contract in self.manifest["modes"].items():
            required = contract["required_reduction_percent"]
            current = metrics([(ROOT / path).read_bytes() for path in contract["runtime_files"]])
            baseline = contract["baseline"]
            for unit in ("words", "bytes"):
                reduction = 100 * (baseline[unit] - current[unit]) / baseline[unit]
                self.assertGreaterEqual(reduction, required, f"{mode} {unit}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
