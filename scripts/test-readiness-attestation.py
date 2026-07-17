#!/usr/bin/env python3
"""Focused strict-schema, snapshot-boundary, and stale-attestation tests."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from build_closed_spec import build_closed_candidate
from create_readiness_attestation import (
    MAX_ATTESTATION_BYTES,
    READINESS_ATTESTATION_FIELDS,
    WORKSPACE_IDENTITY_FIELDS,
    create_readiness_attestation,
    validate_readiness_attestation,
    workspace_authority_snapshot_sha256,
)
from validate_spec_lifecycle import ValidationError, validate_workspace, workspace_snapshot


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "skills/stnl-spec-lifecycle-manager/examples/validator-fixtures"
CREATOR = ROOT / "scripts/create_readiness_attestation.py"
RENDERER = ROOT / "scripts/build_closed_spec.py"


class ReadinessAttestationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self._fresh_source("source")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _fresh_source(self, name: str) -> Path:
        source = self.root / name
        shutil.copytree(FIXTURES / "ready", source)
        return source

    def _create(
        self,
        *,
        source: Path | None = None,
        name: str = "readiness-attestation.json",
        scope: str = "GLOBAL",
        verdict: str = "READY",
    ) -> Path:
        return create_readiness_attestation(
            source or self.source,
            self.root / name,
            scope=scope,
            verdict=verdict,
        )

    def _build(
        self,
        attestation: Path,
        *,
        source: Path | None = None,
        name: str = "candidate",
    ) -> Path:
        return build_closed_candidate(
            source or self.source,
            self.root / name,
            readiness_attestation=attestation,
        )

    def _payload(self, attestation: Path) -> dict[str, object]:
        return json.loads(attestation.read_text(encoding="utf-8"))

    def _write_payload(self, name: str, payload: dict[str, object]) -> Path:
        path = self.root / name
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return path

    def test_payload_is_exact_minimal_and_deterministic(self) -> None:
        first = self._create(name="first.json")
        second = self._create(name="second.json")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        payload = self._payload(first)
        self.assertEqual(set(payload), READINESS_ATTESTATION_FIELDS)
        self.assertEqual(set(payload["workspace_identity"]), WORKSPACE_IDENTITY_FIELDS)
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["mode"], "READINESS")
        self.assertEqual(payload["scope"], "GLOBAL")
        self.assertEqual(payload["verdict"], "READY")
        self.assertRegex(payload["workspace_snapshot_sha256"], r"^[0-9a-f]{64}$")

    def test_creator_cli_contract_and_unicode_are_deterministic(self) -> None:
        feature = self.source / "feature_spec.md"
        feature.write_text(
            feature.read_text(encoding="utf-8")
            .replace(
                "# Fixture Feature - Feature SPEC",
                "# Café 東京 - Feature SPEC",
            )
            .replace(
                "Provide deterministic invitation expiration behavior.",
                "Preservar café, ação e 東京 deterministically.",
            ),
            encoding="utf-8",
        )
        outputs = (self.root / "cli-a.json", self.root / "cli-b.json")
        for output in outputs:
            completed = subprocess.run(
                [
                    "python3",
                    str(CREATOR),
                    str(self.source),
                    str(output),
                    "--scope",
                    "GLOBAL",
                    "--verdict",
                    "READY",
                ],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
        self.assertEqual(
            self._payload(outputs[0])["workspace_identity"]["h1"],
            "# Café 東京 - Feature SPEC",
        )
        candidate = self._build(outputs[0])
        self.assertIn(
            "東京",
            (candidate / "feature_spec.md").read_text(encoding="utf-8"),
        )

    def test_creator_rejects_non_global_or_non_ready_decisions(self) -> None:
        cases = (
            ("LOCAL", "READY", "scope GLOBAL"),
            ("GLOBAL", "BLOCKED", "verdict READY"),
            ("GLOBAL", "UNKNOWN", "verdict READY"),
        )
        for index, (scope, verdict, diagnostic) in enumerate(cases):
            with self.subTest(scope=scope, verdict=verdict):
                output = self.root / f"rejected-{index}.json"
                with self.assertRaisesRegex(ValidationError, diagnostic):
                    create_readiness_attestation(
                        self.source,
                        output,
                        scope=scope,
                        verdict=verdict,
                    )
                self.assertFalse(output.exists())

    def test_creator_rejects_invalid_workspace_and_unsafe_output_paths(self) -> None:
        criterion = self.source / "shared/acceptance-criteria.md"
        criterion.write_text(
            criterion.read_text(encoding="utf-8").replace("D-001", "D-999", 1),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValidationError, "broken_references"):
            self._create(name="invalid-workspace.json")

        source = self._fresh_source("safe-source")
        with self.assertRaisesRegex(ValidationError, "outside the workspace"):
            create_readiness_attestation(
                source,
                source / "readiness-attestation.json",
                scope="GLOBAL",
                verdict="READY",
            )
        traversal = self.root / "unused" / ".." / "traversal.json"
        with self.assertRaisesRegex(ValidationError, "path traversal"):
            create_readiness_attestation(
                source,
                traversal,
                scope="GLOBAL",
                verdict="READY",
            )
        target = self.root / "external-target.json"
        target.write_text("external", encoding="utf-8")
        symlink = self.root / "attestation-symlink.json"
        os.symlink(target, symlink)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            create_readiness_attestation(
                source,
                symlink,
                scope="GLOBAL",
                verdict="READY",
            )
        self.assertEqual(target.read_text(encoding="utf-8"), "external")

        real_parent = self.root / "real-parent"
        real_parent.mkdir()
        linked_parent = self.root / "linked-parent"
        os.symlink(real_parent, linked_parent)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            create_readiness_attestation(
                source,
                linked_parent / "attestation.json",
                scope="GLOBAL",
                verdict="READY",
            )

        safe_attestation = self._create(source=source, name="safe-attestation.json")
        with self.assertRaisesRegex(ValidationError, "path traversal"):
            build_closed_candidate(
                source,
                self.root / "unused" / ".." / "candidate",
                readiness_attestation=safe_attestation,
            )

    def test_schema_rejects_unknown_duplicate_wrong_mode_scope_verdict_version_and_hash(self) -> None:
        valid = self._create(name="valid.json")
        base = self._payload(valid)
        cases: list[tuple[str, dict[str, object], str]] = []

        unknown = copy.deepcopy(base)
        unknown["unexpected"] = True
        cases.append(("unknown", unknown, "unknown=\\['unexpected'\\]"))
        identity_unknown = copy.deepcopy(base)
        identity_unknown["workspace_identity"]["unexpected"] = "value"
        cases.append(("identity-unknown", identity_unknown, "workspace_identity fields"))
        for name, field, value, diagnostic in (
            ("version", "version", 2, "unsupported version"),
            ("mode", "mode", "CLOSE", "mode READINESS"),
            ("local", "scope", "LOCAL", "scope GLOBAL"),
            ("blocked", "verdict", "BLOCKED", "verdict READY"),
            ("unknown-verdict", "verdict", "UNKNOWN", "verdict READY"),
            ("hash", "workspace_snapshot_sha256", "invalid", "lowercase SHA-256"),
        ):
            payload = copy.deepcopy(base)
            payload[field] = value
            cases.append((name, payload, diagnostic))

        for index, (name, payload, diagnostic) in enumerate(cases):
            with self.subTest(name=name):
                attestation = self._write_payload(f"{name}.json", payload)
                candidate = self.root / f"candidate-schema-{index}"
                with self.assertRaisesRegex(ValidationError, diagnostic):
                    build_closed_candidate(
                        self.source,
                        candidate,
                        readiness_attestation=attestation,
                    )
                self.assertFalse(candidate.exists())

        raw = valid.read_text(encoding="utf-8")
        duplicates = (
            raw.replace('"mode":"READINESS"', '"mode":"READINESS","mode":"READINESS"', 1),
            raw.replace(
                '"h1":"# Fixture Feature - Feature SPEC"',
                '"h1":"# Fixture Feature - Feature SPEC","h1":"# Fixture Feature - Feature SPEC"',
                1,
            ),
        )
        for index, duplicate in enumerate(duplicates):
            with self.subTest(duplicate=index):
                attestation = self.root / f"duplicate-{index}.json"
                attestation.write_text(duplicate, encoding="utf-8")
                with self.assertRaisesRegex(ValidationError, "duplicate JSON field"):
                    self._build(attestation, name=f"candidate-duplicate-{index}")

    def test_schema_rejects_missing_wrong_types_malformed_and_oversized_json(self) -> None:
        valid = self._create(name="valid.json")
        base = self._payload(valid)

        missing = copy.deepcopy(base)
        missing.pop("verdict")
        wrong_version_type = copy.deepcopy(base)
        wrong_version_type["version"] = True
        wrong_identity_type = copy.deepcopy(base)
        wrong_identity_type["workspace_identity"] = []
        missing_identity_field = copy.deepcopy(base)
        missing_identity_field["workspace_identity"].pop("h1")
        uppercase_digest = copy.deepcopy(base)
        uppercase_digest["workspace_snapshot_sha256"] = str(
            uppercase_digest["workspace_snapshot_sha256"]
        ).upper()

        cases = (
            ("missing", missing, "missing=\\['verdict'\\]"),
            ("bool-version", wrong_version_type, "unsupported version"),
            ("identity-array", wrong_identity_type, "workspace_identity must be a JSON object"),
            ("identity-missing", missing_identity_field, "missing=\\['h1'\\]"),
            ("uppercase-digest", uppercase_digest, "lowercase SHA-256"),
        )
        for index, (name, payload, diagnostic) in enumerate(cases):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValidationError, diagnostic):
                    self._build(
                        self._write_payload(f"strict-{name}.json", payload),
                        name=f"strict-candidate-{index}",
                    )

        root_array = self.root / "root-array.json"
        root_array.write_text("[]\n", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "root must be a JSON object"):
            self._build(root_array, name="root-array-candidate")

        invalid_constant = self.root / "invalid-constant.json"
        invalid_constant.write_text(
            valid.read_text(encoding="utf-8").replace('"version":1', '"version":NaN'),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValidationError, "invalid JSON constant"):
            self._build(invalid_constant, name="invalid-constant-candidate")

        malformed_utf8 = self.root / "malformed-utf8.json"
        malformed_utf8.write_bytes(b"{\"version\":\xff}")
        with self.assertRaisesRegex(ValidationError, "malformed"):
            self._build(malformed_utf8, name="malformed-utf8-candidate")

        oversized = self.root / "oversized.json"
        oversized.write_bytes(b" " * (MAX_ATTESTATION_BYTES + 1))
        with self.assertRaisesRegex(ValidationError, "safe size limit"):
            self._build(oversized, name="oversized-candidate")

    def test_wrong_workspace_h1_digest_and_symlink_are_rejected(self) -> None:
        valid = self._create(name="valid.json")
        other = self._fresh_source("other-source")
        with self.assertRaisesRegex(ValidationError, "workspace identity"):
            self._build(valid, source=other, name="other-candidate")

        wrong_h1 = self._payload(valid)
        wrong_h1["workspace_identity"]["h1"] = "# Another Feature - Feature SPEC"
        with self.assertRaisesRegex(ValidationError, "workspace identity"):
            self._build(self._write_payload("wrong-h1.json", wrong_h1), name="wrong-h1-candidate")

        wrong_digest = self._payload(valid)
        wrong_digest["workspace_snapshot_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValidationError, "stale"):
            self._build(
                self._write_payload("wrong-digest.json", wrong_digest),
                name="wrong-digest-candidate",
            )

        linked = self.root / "linked.json"
        os.symlink(valid, linked)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            self._build(linked, name="linked-candidate")

    def test_attestation_input_rejects_traversal_internal_paths_and_link_aliases(self) -> None:
        valid = self._create(name="valid.json")

        traversal = self.root / "unused" / ".." / valid.name
        with self.assertRaisesRegex(ValidationError, "path traversal"):
            self._build(traversal, name="traversal-candidate")

        internal = self.source / "manual-attestation.json"
        shutil.copy2(valid, internal)
        with self.assertRaisesRegex(ValidationError, "outside the workspace"):
            self._build(internal, name="internal-candidate")

        real_parent = self.root / "real-attestation-parent"
        real_parent.mkdir()
        real_attestation = real_parent / "attestation.json"
        shutil.copy2(valid, real_attestation)
        linked_parent = self.root / "linked-attestation-parent"
        os.symlink(real_parent, linked_parent)
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            self._build(
                linked_parent / real_attestation.name,
                name="linked-parent-candidate",
            )

        hardlinked = self.root / "hardlinked-attestation.json"
        os.link(valid, hardlinked)
        with self.assertRaisesRegex(ValidationError, "single-link regular file"):
            self._build(hardlinked, name="hardlinked-candidate")

    def test_case_variant_physical_workspace_alias_cannot_hide_internal_attestation(self) -> None:
        real_parent = self.root / "ParentCase"
        real_parent.mkdir()
        source = real_parent / "Source"
        shutil.copytree(FIXTURES / "ready", source)
        alias_parent = self.root / "parentcase"
        alias_source = alias_parent / "source"
        try:
            same_parent = os.path.samefile(real_parent, alias_parent)
            same_source = os.path.samefile(source, alias_source)
        except FileNotFoundError:
            self.skipTest("filesystem is case-sensitive")
        if not (same_parent and same_source):
            self.skipTest("filesystem is case-sensitive")

        requested_output = alias_source / "readiness-attestation.json"
        with self.assertRaisesRegex(ValidationError, "outside the workspace"):
            create_readiness_attestation(
                source,
                requested_output,
                scope="GLOBAL",
                verdict="READY",
            )
        self.assertFalse((source / requested_output.name).exists())

        valid = self._create(source=source, name="case-alias-valid.json")
        internal = source / "manual-attestation.json"
        shutil.copy2(valid, internal)
        before_source = workspace_snapshot(source)
        before_internal = internal.read_bytes()
        candidate = self.root / "case-alias-candidate"
        with self.assertRaisesRegex(ValidationError, "outside the workspace"):
            build_closed_candidate(
                source,
                candidate,
                readiness_attestation=alias_source / internal.name,
            )
        self.assertFalse(candidate.exists())
        self.assertEqual(list(self.root.glob(".case-alias-candidate.close-stage-*")), [])
        self.assertEqual(workspace_snapshot(source), before_source)
        self.assertEqual(internal.read_bytes(), before_internal)

    def test_nested_symlink_ancestor_is_rejected_without_touching_external_target(self) -> None:
        valid = self._create(name="valid-nested.json")
        external = self.root / "external-attestation-target"
        nested = external / "one" / "two"
        nested.mkdir(parents=True)
        sentinel = external / "sentinel.bin"
        sentinel.write_bytes(b"external target must remain unchanged\x00")
        external_attestation = nested / "existing-attestation.json"
        shutil.copy2(valid, external_attestation)
        before_sentinel = sentinel.read_bytes()
        before_attestation = external_attestation.read_bytes()

        alias = self.root / "attestation-alias"
        os.symlink(external, alias)
        aliased_parent = alias / "one" / "two"
        self.assertFalse(aliased_parent.is_symlink())

        created_through_alias = aliased_parent / "created-attestation.json"
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            create_readiness_attestation(
                self.source,
                created_through_alias,
                scope="GLOBAL",
                verdict="READY",
            )
        self.assertFalse((nested / created_through_alias.name).exists())

        aliased_attestation = aliased_parent / external_attestation.name
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            validate_readiness_attestation(self.source, aliased_attestation)

        candidate = self.root / "nested-alias-candidate"
        with self.assertRaisesRegex(ValidationError, "symlink components"):
            build_closed_candidate(
                self.source,
                candidate,
                readiness_attestation=aliased_attestation,
            )
        self.assertFalse(candidate.exists())
        self.assertEqual(list(self.root.glob(".nested-alias-candidate.close-stage-*")), [])
        self.assertEqual(sentinel.read_bytes(), before_sentinel)
        self.assertEqual(external_attestation.read_bytes(), before_attestation)

    def test_authority_hardlink_is_rejected_before_attestation_creation(self) -> None:
        authority = self.source / "shared/requirements.md"
        external_hardlink = self.root / "requirements-hardlink.md"
        os.link(authority, external_hardlink)
        before = external_hardlink.read_bytes()
        output = self.root / "hardlinked-authority-attestation.json"

        with self.assertRaisesRegex(ValidationError, "authority must be a single-link"):
            create_readiness_attestation(
                self.source,
                output,
                scope="GLOBAL",
                verdict="READY",
            )
        self.assertFalse(output.exists())
        self.assertEqual(external_hardlink.read_bytes(), before)

    def test_special_file_attestation_inputs_fail_fast_without_candidate(self) -> None:
        fifo = self.root / "attestation.fifo"
        os.mkfifo(fifo)
        directory = self.root / "attestation-directory"
        directory.mkdir()

        for index, attestation in enumerate((fifo, directory)):
            with self.subTest(kind=attestation.name):
                candidate = self.root / f"special-file-candidate-{index}"
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
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertIn("single-link regular file", completed.stderr)
                self.assertFalse(candidate.exists())

    def _assert_valid_stale_mutation(self, name: str, mutate: object) -> None:
        source = self._fresh_source(f"source-{name}")
        attestation = self._create(source=source, name=f"{name}.json")
        mutate(source)
        validate_workspace(source)
        candidate = self.root / f"candidate-{name}"
        with self.assertRaisesRegex(ValidationError, "stale"):
            build_closed_candidate(source, candidate, readiness_attestation=attestation)
        self.assertFalse(candidate.exists())

    def test_stale_attestation_rejects_every_authority_change(self) -> None:
        def objective(source: Path) -> None:
            path = source / "feature_spec.md"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "Provide deterministic invitation expiration behavior.",
                    "Changed after READINESS GLOBAL.",
                ),
                encoding="utf-8",
            )

        def whitespace(source: Path) -> None:
            path = source / "feature_spec.md"
            path.write_bytes(path.read_bytes() + b"\n")

        def requirement(source: Path) -> None:
            path = source / "shared/requirements.md"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.",
                    "Changed requirement authority after readiness.",
                ),
                encoding="utf-8",
            )

        def acceptance_criterion(source: Path) -> None:
            path = source / "shared/acceptance-criteria.md"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "a API rejeita a aceitação com o envelope público de convite expirado",
                    "a API retorna um resultado revisado depois da readiness global",
                ),
                encoding="utf-8",
            )

        def status(source: Path) -> None:
            path = source / "shared/risks.md"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "- status: active\n- impact: medium",
                    "- status: retired\n- retired_reason: Monitoring eliminated this exposure.\n- impact: medium",
                ),
                encoding="utf-8",
            )

        def add_record(source: Path) -> None:
            feature = source / "feature_spec.md"
            feature.write_text(
                feature.read_text(encoding="utf-8").replace("- R-001\n", "- R-001\n- R-002\n", 1),
                encoding="utf-8",
            )
            requirements = source / "shared/requirements.md"
            requirements.write_text(
                requirements.read_text(encoding="utf-8")
                + """\n### R-002 — Retired duplicate requirement

- status: retired
- retired_reason: The requirement duplicated R-001 and remains reserved for history.

This authority remains as a documentary tombstone.
""",
                encoding="utf-8",
            )

        def remove_record(source: Path) -> None:
            feature = source / "feature_spec.md"
            feature.write_text(
                feature.read_text(encoding="utf-8").replace(
                    "  risks: shared/risks.md\n", ""
                ),
                encoding="utf-8",
            )
            (source / "shared/risks.md").unlink()
            criteria = source / "shared/acceptance-criteria.md"
            criteria.write_text(
                criteria.read_text(encoding="utf-8").replace(
                    "- references: [D-001, C-001, RK-001]",
                    "- references: [D-001, C-001]",
                ),
                encoding="utf-8",
            )

        for name, mutation in (
            ("objective", objective),
            ("whitespace", whitespace),
            ("requirement", requirement),
            ("acceptance-criterion", acceptance_criterion),
            ("status", status),
            ("add-record", add_record),
            ("remove-record", remove_record),
        ):
            with self.subTest(name=name):
                self._assert_valid_stale_mutation(name, mutation)

    def test_new_attestation_after_change_closes_successfully(self) -> None:
        stale_attestation = self._create(name="stale-attestation.json")
        stale_bytes = stale_attestation.read_bytes()
        feature = self.source / "feature_spec.md"
        feature.write_text(
            feature.read_text(encoding="utf-8").replace(
                "Provide deterministic invitation expiration behavior.",
                "Reviewed replacement objective.",
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValidationError, "stale"):
            self._build(stale_attestation, name="stale-candidate")
        self.assertFalse((self.root / "stale-candidate").exists())
        self.assertEqual(stale_attestation.read_bytes(), stale_bytes)
        stale_attestation.unlink()
        self.assertFalse(stale_attestation.exists())

        fresh_attestation = self._create(name="fresh-attestation.json")
        candidate = self._build(fresh_attestation, name="fresh-candidate")
        self.assertIn(
            "Reviewed replacement objective.",
            (candidate / "feature_spec.md").read_text(encoding="utf-8"),
        )
        fresh_attestation.unlink()
        self.assertFalse(fresh_attestation.exists())
        self.assertEqual(list(self.root.glob("*attestation*.json")), [])

    def test_external_execution_metadata_and_persistent_lock_do_not_change_snapshot(self) -> None:
        attestation = self._create()
        before = workspace_authority_snapshot_sha256(validate_workspace(self.source))
        execution = self.source / "execution"
        execution.mkdir()
        (execution / "evidence.bin").write_bytes(b"external\x00evidence")
        (self.source / ".DS_Store").write_bytes(b"ignored")
        lock = self.source.parent / f".{self.source.name}.lifecycle.lock"
        lock.write_text("runtime metadata", encoding="utf-8")
        journal = self.source.parent / f".{self.source.name}.lifecycle-transaction.json"
        journal.write_text("runtime metadata", encoding="utf-8")
        after_workspace, after = validate_readiness_attestation(self.source, attestation)
        self.assertEqual(before, after)
        self.assertEqual(after, workspace_authority_snapshot_sha256(after_workspace))

        candidate = self._build(attestation)
        self.assertEqual((candidate / "execution/evidence.bin").read_bytes(), b"external\x00evidence")
        self.assertFalse((candidate / lock.name).exists())
        self.assertFalse((candidate / journal.name).exists())
        self.assertEqual(list(candidate.rglob("*attestation*")), [])
        self.assertNotIn(
            "workspace_snapshot_sha256",
            (candidate / "feature_spec.md").read_text(encoding="utf-8"),
        )

    def test_attestation_inside_candidate_boundary_is_rejected(self) -> None:
        attestation = self._create()
        with self.assertRaisesRegex(ValidationError, "outside the candidate"):
            validate_readiness_attestation(
                self.source,
                attestation,
                candidate=self.root,
            )

    def test_close_preserves_valid_retired_tombstone_bytes(self) -> None:
        feature = self.source / "feature_spec.md"
        feature.write_text(
            feature.read_text(encoding="utf-8").replace("- R-001\n", "- R-001\n- R-002\n", 1),
            encoding="utf-8",
        )
        requirements = self.source / "shared/requirements.md"
        tombstone = b"""### R-002 \xe2\x80\x94 Retired duplicate requirement

- status: retired
- retired_reason: The requirement duplicated R-001 and remains reserved for history.

This authority remains as a documentary tombstone.
"""
        requirements.write_bytes(requirements.read_bytes() + b"\n" + tombstone)
        validate_workspace(self.source)
        candidate = self._build(self._create())
        self.assertIn(tombstone, (candidate / "feature_spec.md").read_bytes())

    def test_legacy_boolean_cli_is_not_accepted_even_with_attestation(self) -> None:
        attestation = self._create()
        completed = subprocess.run(
            [
                "python3",
                str(RENDERER),
                str(self.source),
                str(self.root / "legacy-candidate"),
                "--readiness-attestation",
                str(attestation),
                "--global-readiness-confirmed",
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unrecognized arguments: --global-readiness-confirmed", completed.stderr)
        self.assertFalse((self.root / "legacy-candidate").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
