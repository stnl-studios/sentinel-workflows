#!/usr/bin/env python3
"""Focused deterministic and adversarial tests for the CLOSE renderer."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build_closed_spec import build_closed_candidate
from create_readiness_attestation import create_readiness_attestation
from validate_spec_lifecycle import (
    ValidationError,
    validate_close_transition,
    validate_workspace,
)


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "skills/stnl-spec-lifecycle-manager/examples/validator-fixtures"
RENDERER = ROOT / "scripts/build_closed_spec.py"


def snapshot(root: Path) -> tuple[tuple[str, str, bytes | str], ...]:
    result: list[tuple[str, str, bytes | str]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            result.append((relative, "symlink", os.readlink(path)))
        elif path.is_dir():
            result.append((relative, "directory", ""))
        elif path.is_file():
            result.append((relative, "file", path.read_bytes()))
    return tuple(result)


def record_region(path: Path) -> bytes:
    data = path.read_bytes()
    offset = data.index(b"### ")
    return data[offset:]


class ClosedSpecRendererTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        shutil.copytree(FIXTURES / "ready", self.source)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def attest(self, name: str = "readiness-attestation.json") -> Path:
        attestation = self.root / name
        return create_readiness_attestation(
            self.source,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )

    def build(
        self,
        name: str = "candidate",
        *,
        attestation: Path | None = None,
    ) -> Path:
        if attestation is None:
            attestation = self.attest()
        return build_closed_candidate(
            self.source,
            self.root / name,
            readiness_attestation=attestation,
        )

    def test_all_categories_match_golden_and_preserve_record_bytes(self) -> None:
        candidate = self.build()
        self.assertEqual(
            (candidate / "feature_spec.md").read_bytes(),
            (FIXTURES / "closed/feature_spec.md").read_bytes(),
        )
        rendered = (candidate / "feature_spec.md").read_bytes()
        for artifact in sorted((self.source / "shared").glob("*.md")):
            self.assertIn(record_region(artifact), rendered)
        validate_close_transition(self.source, candidate)

    def test_absent_optional_categories_are_omitted(self) -> None:
        feature = self.source / "feature_spec.md"
        data = feature.read_text(encoding="utf-8")
        for line in (
            "  decisions: shared/decisions.md\n",
            "  constraints: shared/constraints.md\n",
            "  risks: shared/risks.md\n",
            "  questions: shared/questions.md\n",
        ):
            data = data.replace(line, "")
        feature.write_text(data, encoding="utf-8")
        for name in ("decisions.md", "constraints.md", "risks.md", "questions.md"):
            (self.source / "shared" / name).unlink()
        criteria = self.source / "shared/acceptance-criteria.md"
        criteria.write_text(
            criteria.read_text(encoding="utf-8").replace(
                "- references: [D-001, C-001, RK-001]\n", ""
            ),
            encoding="utf-8",
        )
        validate_workspace(self.source)

        rendered = (self.build() / "feature_spec.md").read_text(encoding="utf-8")
        for heading in (
            "Durable Decisions",
            "Relevant Constraints",
            "Relevant Risks",
            "Durable Resolved Questions",
        ):
            self.assertNotIn(f"## {heading}\n", rendered)

    def test_unicode_and_long_narrative_are_copied_verbatim(self) -> None:
        feature = self.source / "feature_spec.md"
        feature.write_text(
            feature.read_text(encoding="utf-8").replace(
                "Provide deterministic invitation expiration behavior.",
                "Preservar expiração determinística — café, ação e 東京. " + "Longa narrativa. " * 80,
            ),
            encoding="utf-8",
        )
        requirement = self.source / "shared/requirements.md"
        requirement.write_text(
            requirement.read_text(encoding="utf-8").replace(
                "An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.",
                "Convite expirado é rejeitado sem participação — exatamente como definido em São Paulo.",
            ),
            encoding="utf-8",
        )
        source_record = record_region(requirement)

        rendered = (self.build() / "feature_spec.md").read_bytes()
        self.assertIn(source_record, rendered)
        self.assertIn("東京".encode("utf-8"), rendered)

    def test_valid_id_gaps_are_preserved(self) -> None:
        replacements = {
            b"R-001": b"R-007",
            b"AC-001": b"AC-004",
            b"D-001": b"D-009",
            b"C-001": b"C-003",
            b"RK-001": b"RK-008",
            b"Q-001": b"Q-006",
        }
        for path in self.source.rglob("*.md"):
            data = path.read_bytes()
            for old, new in replacements.items():
                data = data.replace(old, new)
            path.write_bytes(data)
        validate_workspace(self.source)

        rendered = (self.build() / "feature_spec.md").read_bytes()
        for identifier in replacements.values():
            self.assertIn(b"### " + identifier + b" ", rendered)

    def test_output_has_final_newline_when_last_source_record_does_not(self) -> None:
        questions = self.source / "shared/questions.md"
        questions.write_bytes(questions.read_bytes().rstrip(b"\n"))
        source_record = record_region(questions)
        validate_workspace(self.source)

        rendered = (self.build() / "feature_spec.md").read_bytes()
        self.assertTrue(rendered.endswith(b"\n"))
        self.assertIn(source_record, rendered)

    def test_repeated_output_is_byte_identical_across_hash_seed_and_locale(self) -> None:
        candidates = (self.root / "candidate-a", self.root / "candidate-b")
        attestation = self.attest()
        locales = ("C", "pt_BR.UTF-8")
        for index, candidate in enumerate(candidates):
            environment = os.environ.copy()
            environment.update(
                {
                    "LC_ALL": locales[index],
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONHASHSEED": str(index + 1),
                }
            )
            completed = subprocess.run(
                [
                    "python3",
                    str(RENDERER),
                    str(self.source),
                    str(candidate),
                    "--readiness-attestation",
                    str(attestation),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(snapshot(candidates[0]), snapshot(candidates[1]))

    def test_external_directories_files_symlinks_and_ignored_metadata(self) -> None:
        execution = self.source / "execution"
        (execution / "empty").mkdir(parents=True)
        (execution / "payload.bin").write_bytes(b"\x00external\xff")
        os.symlink("payload.bin", execution / "payload-link")
        (self.source / ".DS_Store").write_bytes(b"ignored")
        (self.source / "._finder").write_bytes(b"ignored")
        (self.source / "__MACOSX").mkdir()
        (self.source / "__MACOSX/ignored").write_bytes(b"ignored")

        candidate = self.build()
        self.assertEqual((candidate / "execution/payload.bin").read_bytes(), b"\x00external\xff")
        self.assertEqual(os.readlink(candidate / "execution/payload-link"), "payload.bin")
        self.assertTrue((candidate / "execution/empty").is_dir())
        self.assertFalse((candidate / ".DS_Store").exists())
        self.assertEqual(list(candidate.rglob("*attestation*")), [])
        validate_close_transition(self.source, candidate)

    def test_external_hardlink_topology_is_preserved_across_trees(self) -> None:
        execution = self.source / "execution"
        assets = self.source / "assets"
        execution.mkdir()
        assets.mkdir()
        first = execution / "payload-a.bin"
        second = execution / "payload-b.bin"
        cross_tree = assets / "payload-c.bin"
        first.write_bytes(b"hardlinked external payload\x00")
        os.link(first, second)
        os.link(first, cross_tree)
        distinct = assets / "same-bytes-distinct.bin"
        distinct.write_bytes(first.read_bytes())
        self.assertEqual(first.stat().st_nlink, 3)

        candidate = self.build()
        copied = (
            candidate / "execution/payload-a.bin",
            candidate / "execution/payload-b.bin",
            candidate / "assets/payload-c.bin",
        )
        identities = {(path.stat().st_dev, path.stat().st_ino) for path in copied}
        self.assertEqual(len(identities), 1)
        self.assertTrue(all(path.stat().st_nlink == 3 for path in copied))
        self.assertTrue(all(path.read_bytes() == first.read_bytes() for path in copied))
        self.assertNotEqual(copied[0].stat().st_ino, first.stat().st_ino)
        self.assertNotEqual(
            (candidate / "assets/same-bytes-distinct.bin").stat().st_ino,
            copied[0].stat().st_ino,
        )
        validate_close_transition(self.source, candidate)

    def test_external_hardlink_peer_outside_workspace_is_rejected(self) -> None:
        execution = self.source / "execution"
        execution.mkdir()
        outside = self.root / "outside.bin"
        outside.write_bytes(b"outside peer must remain independent\n")
        linked = execution / "linked.bin"
        os.link(outside, linked)
        source_before = snapshot(self.source)
        outside_before = outside.read_bytes()

        with self.assertRaisesRegex(ValidationError, "crosses the CLOSE preservation boundary"):
            self.build()
        self.assertEqual(snapshot(self.source), source_before)
        self.assertEqual(outside.read_bytes(), outside_before)
        self.assertEqual(outside.stat().st_ino, linked.stat().st_ino)
        self.assertFalse((self.root / "candidate").exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_external_hardlink_peer_in_ignored_metadata_is_rejected(self) -> None:
        execution = self.source / "execution"
        execution.mkdir()
        linked = execution / "linked.bin"
        linked.write_bytes(b"metadata peer\n")
        os.link(linked, self.source / ".DS_Store")
        source_before = snapshot(self.source)

        with self.assertRaisesRegex(ValidationError, "crosses the CLOSE preservation boundary"):
            self.build()
        self.assertEqual(snapshot(self.source), source_before)
        self.assertFalse((self.root / "candidate").exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_external_hardlinked_symlinks_are_preserved_without_following(self) -> None:
        execution = self.source / "execution"
        execution.mkdir()
        (execution / "target.bin").write_bytes(b"target\n")
        first = execution / "alias-a"
        second = execution / "alias-b"
        os.symlink("target.bin", first)
        os.link(first, second, follow_symlinks=False)

        candidate = self.build()
        copied_first = candidate / "execution/alias-a"
        copied_second = candidate / "execution/alias-b"
        self.assertTrue(copied_first.is_symlink())
        self.assertTrue(copied_second.is_symlink())
        self.assertEqual(os.readlink(copied_first), "target.bin")
        self.assertEqual(os.lstat(copied_first).st_ino, os.lstat(copied_second).st_ino)
        self.assertEqual(os.lstat(copied_first).st_nlink, 2)
        self.assertNotEqual(os.lstat(copied_first).st_ino, os.lstat(first).st_ino)
        validate_close_transition(self.source, candidate)

    def test_external_hardlink_copy_failure_cleans_owned_stage(self) -> None:
        execution = self.source / "execution"
        execution.mkdir()
        first = execution / "payload-a.bin"
        first.write_bytes(b"hardlink failure fixture\n")
        os.link(first, execution / "payload-b.bin")
        source_before = snapshot(self.source)

        with patch("build_closed_spec.os.link", side_effect=OSError("injected link failure")):
            with self.assertRaisesRegex(OSError, "injected link failure"):
                self.build()
        self.assertEqual(snapshot(self.source), source_before)
        self.assertFalse((self.root / "candidate").exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_transition_rejects_extra_item(self) -> None:
        candidate = self.build()
        feature = candidate / "feature_spec.md"
        extra = b"""### R-999 \xe2\x80\x94 Invented requirement

- status: in_scope
- coverage_justification: This documentary-only requirement has no observable acceptance behavior.

This record was not present in the active source.

"""
        feature.write_bytes(
            feature.read_bytes().replace(b"## Business Rules\n", extra + b"## Business Rules\n", 1)
        )
        with self.assertRaisesRegex(ValidationError, "invented canonical items"):
            validate_close_transition(self.source, candidate)

    def test_transition_rejects_removed_final_question(self) -> None:
        candidate = self.build()
        feature = candidate / "feature_spec.md"
        data = feature.read_bytes()
        feature.write_bytes(data[: data.index(b"## Durable Resolved Questions\n")])
        with self.assertRaisesRegex(ValidationError, "discarded canonical items"):
            validate_close_transition(self.source, candidate)

    def test_transition_rejects_text_mutation(self) -> None:
        candidate = self.build()
        feature = candidate / "feature_spec.md"
        feature.write_bytes(
            feature.read_bytes().replace(
                b"An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.",
                b"A rewritten requirement changes durable authority.",
                1,
            )
        )
        with self.assertRaisesRegex(ValidationError, "changed canonical content for R-001"):
            validate_close_transition(self.source, candidate)

    def test_prepublish_failure_leaves_source_and_candidate_untouched(self) -> None:
        before = snapshot(self.source)
        candidate = self.root / "candidate"
        with patch(
            "build_closed_spec.validate_close_transition",
            side_effect=ValidationError("injected prepublish failure"),
        ):
            with self.assertRaisesRegex(ValidationError, "injected prepublish failure"):
                self.build()
        self.assertEqual(snapshot(self.source), before)
        self.assertFalse(candidate.exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_unsafe_candidate_paths_are_rejected_without_rendering(self) -> None:
        attestation = self.attest()

        linked_candidate = self.root / "linked-candidate"
        os.symlink(self.root / "missing-candidate-target", linked_candidate)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            build_closed_candidate(
                self.source,
                linked_candidate,
                readiness_attestation=attestation,
            )

        real_parent = self.root / "real-candidate-parent"
        real_parent.mkdir()
        linked_parent = self.root / "linked-candidate-parent"
        os.symlink(real_parent, linked_parent)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            build_closed_candidate(
                self.source,
                linked_parent / "candidate",
                readiness_attestation=attestation,
            )
        self.assertEqual(list(real_parent.iterdir()), [])

        internal = self.source / "candidate"
        with self.assertRaisesRegex(ValidationError, "disjoint directories"):
            build_closed_candidate(
                self.source,
                internal,
                readiness_attestation=attestation,
            )
        self.assertFalse(internal.exists())

    def test_nested_source_and_candidate_aliases_are_rejected_without_external_mutation(self) -> None:
        external_source_root = self.root / "external-source-root"
        real_source = external_source_root / "one" / "source"
        real_source.parent.mkdir(parents=True)
        shutil.copytree(FIXTURES / "ready", real_source)
        source_attestation = create_readiness_attestation(
            real_source,
            self.root / "nested-source-attestation.json",
            scope="GLOBAL",
            verdict="READY",
        )
        source_before = snapshot(real_source)
        source_alias = self.root / "source-alias"
        os.symlink(external_source_root, source_alias)
        aliased_source = source_alias / "one" / "source"
        self.assertFalse(aliased_source.is_symlink())
        source_candidate = self.root / "source-alias-candidate"

        with self.assertRaisesRegex(ValidationError, "symlink components"):
            build_closed_candidate(
                aliased_source,
                source_candidate,
                readiness_attestation=source_attestation,
            )
        self.assertFalse(source_candidate.exists())
        self.assertEqual(list(self.root.glob(".source-alias-candidate.close-stage-*")), [])
        self.assertEqual(snapshot(real_source), source_before)

        candidate_target = self.root / "external-candidate-root"
        real_candidate_parent = candidate_target / "one" / "two"
        real_candidate_parent.mkdir(parents=True)
        sentinel = candidate_target / "sentinel.bin"
        sentinel.write_bytes(b"candidate alias target must remain unchanged\x00")
        sentinel_before = sentinel.read_bytes()
        candidate_alias = self.root / "candidate-alias"
        os.symlink(candidate_target, candidate_alias)
        aliased_candidate = candidate_alias / "one" / "two" / "candidate"
        self.assertFalse(aliased_candidate.parent.is_symlink())
        attestation = self.attest(name="nested-candidate-attestation.json")

        with self.assertRaisesRegex(ValidationError, "symlink components"):
            build_closed_candidate(
                self.source,
                aliased_candidate,
                readiness_attestation=attestation,
            )
        self.assertFalse((real_candidate_parent / "candidate").exists())
        self.assertEqual(list(real_candidate_parent.glob(".candidate.close-stage-*")), [])
        self.assertEqual(sentinel.read_bytes(), sentinel_before)

    def test_source_change_after_transition_validation_blocks_candidate(self) -> None:
        attestation = self.attest()
        candidate = self.root / "candidate"

        def mutate_source_after_validation(source: Path, stage: Path) -> object:
            result = validate_close_transition(source, stage)
            feature = self.source / "feature_spec.md"
            feature.write_text(
                feature.read_text(encoding="utf-8").replace(
                    "Provide deterministic invitation expiration behavior.",
                    "Changed after CLOSE transition validation.",
                ),
                encoding="utf-8",
            )
            validate_workspace(self.source)
            return result

        with patch(
            "build_closed_spec.validate_close_transition",
            side_effect=mutate_source_after_validation,
        ):
            with self.assertRaisesRegex(ValidationError, "became stale"):
                build_closed_candidate(
                    self.source,
                    candidate,
                    readiness_attestation=attestation,
                )
        self.assertFalse(candidate.exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_source_change_inside_final_rename_rolls_back_owned_candidate(self) -> None:
        attestation = self.attest()
        candidate = self.root / "candidate"
        canonical_candidate = candidate.resolve()
        real_replace = os.replace

        def rename_then_mutate_source(source: Path, destination: Path) -> None:
            real_replace(source, destination)
            if Path(destination) != canonical_candidate:
                return
            feature = self.source / "feature_spec.md"
            feature.write_text(
                feature.read_text(encoding="utf-8").replace(
                    "Provide deterministic invitation expiration behavior.",
                    "Changed inside the final candidate rename.",
                ),
                encoding="utf-8",
            )
            validate_workspace(self.source)

        with patch("build_closed_spec.os.replace", side_effect=rename_then_mutate_source):
            with self.assertRaisesRegex(ValidationError, "became stale"):
                build_closed_candidate(
                    self.source,
                    candidate,
                    readiness_attestation=attestation,
                )
        self.assertFalse(candidate.exists())
        self.assertEqual(list(self.root.glob(".candidate.close-stage-*")), [])

    def test_readiness_attestation_is_mandatory(self) -> None:
        before = snapshot(self.source)
        candidate = self.root / "candidate"
        completed = subprocess.run(
            [
                "python3",
                str(RENDERER),
                self.source,
                candidate,
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("--readiness-attestation", completed.stderr)
        self.assertEqual(snapshot(self.source), before)
        self.assertFalse(candidate.exists())

    def test_legacy_global_readiness_boolean_is_rejected(self) -> None:
        completed = subprocess.run(
            [
                "python3",
                str(RENDERER),
                str(self.source),
                str(self.root / "candidate"),
                "--global-readiness-confirmed",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("--readiness-attestation", completed.stderr)
        self.assertFalse((self.root / "candidate").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
