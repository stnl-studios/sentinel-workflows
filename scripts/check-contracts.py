#!/usr/bin/env python3
"""Focused semantic contract checks for launchers and validation-runner templates."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    tomllib = None


class ContractViolation(Exception):
    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category


class InfrastructureError(Exception):
    pass


def reject(category: str, message: str) -> None:
    raise ContractViolation(category, message)


def read_text(path: Path, category: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        reject(category, f"missing required file: {path}")
    except (OSError, UnicodeError) as exc:
        raise InfrastructureError(f"cannot read {path}: {exc}") from exc


def is_packaging_metadata(path: Path, root: Path) -> bool:
    relative = path.relative_to(root)
    return (
        "__MACOSX" in relative.parts
        or path.name == ".DS_Store"
        or path.name.startswith("._")
    )


@dataclass(frozen=True)
class LauncherSpec:
    skill: str
    input_kind: str
    operation: str
    inputs: tuple[tuple[str, str], ...]
    instructions: tuple[str, ...] = ()


CONTEXT_HEADING = "Contexto adicional (opcional):"
CODEX_INSTRUCTIONS = (
    "Faça spawn do agente customizado `stnl_validation_runner` para executar a validação independente.",
    "Aguarde o retorno. O contexto principal somente adiciona a Validation Attempt e, em `PASS` válido, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.",
    "Se o agente não iniciar ou não retornar resultado válido, persista e retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.",
)
CLAUDE_INSTRUCTIONS = (
    "Delegue obrigatoriamente a validação independente para:",
    "@agent-stnl-validation-runner",
    CODEX_INSTRUCTIONS[1],
    CODEX_INSTRUCTIONS[2],
)


LAUNCHERS = {
    "spec-init": LauncherSpec(
        "stnl-spec-lifecycle-manager",
        "MODE",
        "INIT",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("REQUIREMENTS_SOURCE", "{{REQUIREMENTS_SOURCE}}")),
    ),
    "spec-resume": LauncherSpec(
        "stnl-spec-lifecycle-manager",
        "MODE",
        "RESUME",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("NEW_INFORMATION", "{{NEW_INFORMATION}}")),
    ),
    "spec-planning": LauncherSpec(
        "stnl-spec-lifecycle-manager", "MODE", "PLANNING", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "spec-close": LauncherSpec(
        "stnl-spec-lifecycle-manager", "MODE", "CLOSE", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "execution-plan": LauncherSpec(
        "stnl-execution-planner", "OPERATION", "PLAN", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "execution-plan-review": LauncherSpec(
        "stnl-plan-reviewer", "OPERATION", "REVIEW_PLAN", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "execution-tasks": LauncherSpec(
        "stnl-task-materializer", "OPERATION", "MATERIALIZE_TASKS", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "execution-tasks-review": LauncherSpec(
        "stnl-task-reviewer", "OPERATION", "REVIEW_TASKS", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "slice-execute": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "EXECUTE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
    ),
    "slice-apply-findings": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "APPLY_FINDINGS",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
    ),
    "execution-close": LauncherSpec(
        "stnl-execution-closer", "OPERATION", "CLOSE", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "slice-validate-codex": LauncherSpec(
        "stnl-slice-quality-manager",
        "OPERATION",
        "VALIDATE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CODEX_INSTRUCTIONS,
    ),
    "slice-validate-claude": LauncherSpec(
        "stnl-slice-quality-manager",
        "OPERATION",
        "VALIDATE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CLAUDE_INSTRUCTIONS,
    ),
}

SHARED_EXECUTION = {
    "execution-plan",
    "execution-plan-review",
    "execution-tasks",
    "execution-tasks-review",
    "slice-execute",
    "slice-apply-findings",
    "execution-close",
}


def launcher_files(root: Path) -> dict[str, Path]:
    return {
        path.stem: path
        for path in root.glob("*.md")
        if path.is_file() and not is_packaging_metadata(path, root)
    }


def parse_launcher(path: Path, spec: LauncherSpec) -> tuple[list[tuple[str, str]], list[str], str]:
    text = read_text(path, "L001_REGISTRY")
    lines = text.splitlines()
    if lines.count(CONTEXT_HEADING) != 1:
        reject("L009_CONTEXT_FORMAT", f"{path}: expected one optional-context heading")
    context_index = lines.index(CONTEXT_HEADING)
    if context_index != len(lines) - 1 or context_index == 0 or lines[context_index - 1] != "":
        reject("L009_CONTEXT_FORMAT", f"{path}: optional-context section is not in canonical final position")

    body = lines[: context_index - 1]
    expected_use = f"Use `{spec.skill}`."
    if not body or body[0] != expected_use:
        reject("L002_SKILL", f"{path}: expected launcher skill {spec.skill}")
    expected_operation = f"{spec.input_kind}={spec.operation}"
    if len(body) < 2 or body[1] != expected_operation:
        reject("L003_OPERATION", f"{path}: expected {expected_operation}")

    assignments: list[tuple[str, str]] = []
    index = 2
    while index < len(body):
        match = re.fullmatch(r"([A-Z_]+)=(.*)", body[index])
        if not match:
            break
        assignments.append(match.groups())
        index += 1
    instructions = body[index:]
    return assignments, instructions, text


def check_launcher_contract(root: Path) -> None:
    if not root.is_dir():
        raise InfrastructureError(f"launcher root is not a directory: {root}")
    actual = launcher_files(root)
    if set(actual) != set(LAUNCHERS):
        missing = sorted(set(LAUNCHERS) - set(actual))
        unexpected = sorted(set(actual) - set(LAUNCHERS))
        reject("L001_REGISTRY", f"launcher registry mismatch; missing={missing}, unexpected={unexpected}")

    texts: dict[str, str] = {}
    for name, spec in LAUNCHERS.items():
        assignments, instructions, text = parse_launcher(actual[name], spec)
        texts[name] = text

        forbidden_removed = ["FINALIZE_SLICE", "PARALLELIZE_SLICES"]
        for token in forbidden_removed:
            if token in text:
                reject("L005_REMOVED_CONTRACT", f"{actual[name]}: removed operation remains: {token}")
        if re.search(r"(?m)^SLICES=", text):
            reject("L005_REMOVED_CONTRACT", f"{actual[name]}: removed SLICES input remains")
        if re.search(r"(?i)paralel|parallel", text):
            reject("L005_REMOVED_CONTRACT", f"{actual[name]}: parallelization instruction remains")

        expected_assignments = list(spec.inputs)
        if assignments != expected_assignments:
            reject(
                "L004_INPUTS",
                f"{actual[name]}: expected inputs {expected_assignments}, found {assignments}",
            )
        placeholders = set(re.findall(r"\{\{([A-Z_]+)\}\}", text))
        raw_placeholders = re.findall(r"\{\{([^{}]+)\}\}", text)
        if any(not re.fullmatch(r"[A-Z_]+", placeholder) for placeholder in raw_placeholders):
            reject("L004_INPUTS", f"{actual[name]}: malformed or unknown placeholder")
        expected_placeholders = {key for key, _ in spec.inputs}
        if placeholders != expected_placeholders:
            reject(
                "L004_INPUTS",
                f"{actual[name]}: placeholder mismatch; expected={sorted(expected_placeholders)}, actual={sorted(placeholders)}",
            )
        if "SLICE" in placeholders and spec.operation not in {"EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"}:
            reject("L004_INPUTS", f"{actual[name]}: SLICE is not allowed for {spec.operation}")

        if name in SHARED_EXECUTION and re.search(
            r"stnl[_-]validation[_-]runner|@agent-|Claude|Codex", text, re.IGNORECASE
        ):
            reject("L006_SHARED_ISOLATION", f"{actual[name]}: shared launcher contains a platform identity")
        if name in {"slice-execute", "slice-apply-findings", "execution-close"} and re.search(
            r"runner|spawn|deleg", text, re.IGNORECASE
        ):
            reject("L006_SHARED_ISOLATION", f"{actual[name]}: non-validation launcher invokes a runner")

        if name == "slice-validate-codex":
            if text.count("stnl_validation_runner") != 1 or "@agent-" in text or "Claude" in text:
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: invalid Codex runner identity")
            if not instructions or instructions[0] != CODEX_INSTRUCTIONS[0]:
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: required Codex spawn invocation is missing")
        elif name == "slice-validate-claude":
            if text.splitlines().count("@agent-stnl-validation-runner") != 1 or "stnl_validation_runner" in text or "Codex" in text:
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: invalid Claude runner identity")
            if instructions[:2] != list(CLAUDE_INSTRUCTIONS[:2]):
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: mandatory Claude delegation is missing")

        if spec.operation == "VALIDATE_SLICE":
            required_flow = {
                "Não faça fallback": "fallback is prohibited",
                "não repete testes": "main context must not rerun tests",
                "não refaz a validação": "main context must not redo validation",
                "não emite outro veredito": "main context must not emit another verdict",
                "substitui a Effective Validation Base e finaliza a slice": "PASS must update the base and finalize",
                "persista e retorne `BLOCKED`": "invalid runner return must remain BLOCKED",
            }
            for marker, description in required_flow.items():
                if marker not in text:
                    reject("L008_VALIDATION_FLOW", f"{actual[name]}: {description}")

        if instructions != list(spec.instructions):
            reject("L010_CANONICAL_CONTENT", f"{actual[name]}: launcher instructions are not canonical")

    runner_mentions = {
        name for name, text in texts.items() if re.search(r"runner|@agent-|spawn|deleg", text, re.IGNORECASE)
    }
    if runner_mentions != {"slice-validate-codex", "slice-validate-claude"}:
        reject("L006_SHARED_ISOLATION", f"runner invocation is not exclusive to VALIDATE_SLICE: {sorted(runner_mentions)}")


def load_toml(path: Path) -> dict:
    text = read_text(path, "R002_REGISTRY")
    if tomllib is not None:
        try:
            return tomllib.loads(text)
        except tomllib.TOMLDecodeError as exc:
            reject("R013_SYNTAX", f"invalid TOML in {path}: {exc}")

    data: dict = {}
    section: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        raw = lines[index]
        index += 1
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = [part.strip('"') for part in line.strip("[]").split(".")]
            cursor = data
            for part in section:
                cursor = cursor.setdefault(part, {})
            continue
        if "=" not in line:
            reject("R013_SYNTAX", f"invalid TOML line in {path}: {raw!r}")
        key, value = (part.strip() for part in line.split("=", 1))
        if value.startswith('"""'):
            collected = [value[3:]]
            while not collected[-1].endswith('"""'):
                if index >= len(lines):
                    reject("R013_SYNTAX", f"unterminated TOML string in {path}: {key}")
                collected.append(lines[index])
                index += 1
            collected[-1] = collected[-1][:-3]
            parsed: object = "\n".join(collected)
        elif value.startswith('"') and value.endswith('"'):
            parsed = value[1:-1]
        elif value.isdigit():
            parsed = int(value)
        else:
            reject("R013_SYNTAX", f"unsupported TOML value in {path}: {raw!r}")
        cursor = data
        for part in section:
            cursor = cursor.setdefault(part, {})
        cursor[key] = parsed
    return data


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    lines = read_text(path, "R002_REGISTRY").splitlines()
    if not lines or lines[0] != "---":
        reject("R013_SYNTAX", f"frontmatter start is missing: {path}")
    try:
        end = lines.index("---", 1)
    except ValueError:
        reject("R013_SYNTAX", f"frontmatter end is missing: {path}")
    data: dict[str, str] = {}
    for line in lines[1:end]:
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):\s+(.+)", line)
        if not match:
            reject("R013_SYNTAX", f"invalid frontmatter line in {path}: {line!r}")
        key, value = match.groups()
        if key in data:
            reject("R013_SYNTAX", f"duplicate frontmatter field in {path}: {key}")
        data[key] = value
    return data, "\n".join(lines[end + 1 :]).strip()


RUNNER_FILES = {
    Path("README.md"),
    Path("codex/.codex/agents/stnl_validation_runner.toml"),
    Path("claude-code/.claude/agents/stnl-validation-runner.md"),
}
OUTPUT_SECTIONS = [
    "Operação:",
    "Tipo de validação: initial | revalidation",
    "Status: PASS | NEEDS_FIX | BLOCKED",
    "Escopo verificado:",
    "HEAD:",
    "Manifesto final da slice:",
    "Comandos executados:",
    "Resultado de cada comando e exit code:",
    "Evidências:",
    "Findings:",
    "Bloqueios:",
    "Overlap com bases anteriores:",
    "Regressões justificadas executadas:",
    "Efeitos inesperados no workspace:",
    "Resumo para persistência:",
]


def runner_files(root: Path) -> set[Path]:
    candidates = [root / "README.md"]
    for adapter_root in [root / "codex/.codex/agents", root / "claude-code/.claude/agents"]:
        if adapter_root.is_dir():
            candidates.extend(adapter_root.rglob("*"))
    return {
        path.relative_to(root)
        for path in candidates
        if path.is_file() and not is_packaging_metadata(path, root)
    }


def extract_output_schema(contract: str) -> list[str]:
    match = re.search(r"# Saída\n.*?```text\n(.*?)```", contract, re.DOTALL)
    if not match:
        reject("R007_OUTPUT_SCHEMA", "runner output schema block is missing")
    return [line for line in match.group(1).splitlines() if line]


def check_runner_contract(root: Path) -> None:
    if not root.is_dir():
        raise InfrastructureError(f"validation-runner root is not a directory: {root}")
    actual = runner_files(root)
    if actual != RUNNER_FILES:
        missing = sorted(map(str, RUNNER_FILES - actual))
        unexpected = sorted(map(str, actual - RUNNER_FILES))
        reject("R002_REGISTRY", f"validation-runner registry mismatch; missing={missing}, unexpected={unexpected}")

    codex_path = root / "codex/.codex/agents/stnl_validation_runner.toml"
    claude_path = root / "claude-code/.claude/agents/stnl-validation-runner.md"
    codex = load_toml(codex_path)
    claude_frontmatter, claude_contract = parse_frontmatter(claude_path)

    if (
        codex.get("name") != "stnl_validation_runner"
        or codex.get("model") != "gpt-5.4-mini"
        or codex.get("model_reasoning_effort") != "medium"
        or codex.get("sandbox_mode") != "workspace-write"
    ):
        reject("R001_ADAPTER_METADATA", "Codex validation-runner identity/model/effort/sandbox changed")
    if codex.get("agents") != {"max_depth": 1}:
        reject("R001_ADAPTER_METADATA", "Codex validation runner permits nested agents")
    expected_claude = {
        "name": "stnl-validation-runner",
        "description": "Validador independente de uma slice, com testes autoritativos, hashes e veredito compacto para persistência pelo contexto principal.",
        "tools": "Read, Glob, Grep, Bash",
        "model": "haiku",
        "effort": "medium",
    }
    if claude_frontmatter != expected_claude:
        reject("R001_ADAPTER_METADATA", "Claude validation-runner identity/tools/model/effort changed")

    codex_contract = codex.get("developer_instructions")
    if not isinstance(codex_contract, str):
        reject("R013_SYNTAX", "Codex developer_instructions must be a string")
    codex_contract = codex_contract.strip()
    if codex_contract != claude_contract:
        reject("R003_EQUIVALENCE", "validation-runner platform contracts diverge")
    contract = codex_contract

    if contract.count("CONTRATO_CANONICO=stnl-validation-runner/v3") != 1:
        reject("R013_SYNTAX", "runner canonical contract identifier is missing or duplicated")
    if contract.count("OPERATION=VALIDATE_SLICE") != 1:
        reject("R004_OPERATION_SCOPE", "runner must accept exactly OPERATION=VALIDATE_SLICE")
    for removed in ["EXECUTE_SLICE", "APPLY_FINDINGS", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "`CLOSE`"]:
        if removed in contract:
            reject("R004_OPERATION_SCOPE", f"validation runner supports removed operation: {removed}")

    independence_markers = [
        "Trate conclusões do contexto principal como não verificadas.",
        "Compare o diff selecionado com plano, tasks, requisitos, critérios, código e dependências necessárias.",
        "Não confie apenas em checkboxes.",
        "Leia somente o escopo selecionado.",
    ]
    for marker in independence_markers:
        if marker not in contract:
            reject("R014_INDEPENDENCE", f"runner independence contract lacks: {marker}")

    read_only_markers = [
        "Não implemente, não corrija, não finalize e não edite artefatos de execução.",
        "Não crie subagentes nem delegue.",
        "Não edite código, testes, requisitos, planos ou tasks.",
        "Não aplique correções",
        "nunca o reverta automaticamente",
    ]
    for marker in read_only_markers:
        if marker not in contract:
            reject("R005_READ_ONLY", f"validation runner lacks prohibition: {marker}")

    if "Retorne somente `PASS`, `NEEDS_FIX` ou `BLOCKED`." not in contract:
        reject("R006_VERDICTS", "runner statuses are not exactly PASS, NEEDS_FIX, and BLOCKED")
    verdict_markers = [
        "`PASS` exige evidência objetiva",
        "todos os exit codes autoritativos zero e manifesto final completo",
        "`NEEDS_FIX` exige finding estruturado.",
        "`BLOCKED` exige causa concreta",
        "Em `NEEDS_FIX` ou `BLOCKED`, não proponha Effective Validation Base.",
    ]
    for marker in verdict_markers:
        if marker not in contract:
            reject("R006_VERDICTS", f"runner verdict contract lacks: {marker}")

    schema = extract_output_schema(contract)
    if schema != OUTPUT_SECTIONS:
        reject("R007_OUTPUT_SCHEMA", f"runner output sections differ; expected={OUTPUT_SECTIONS}, actual={schema}")

    manifest_markers = [
        "Capture o `HEAD` atual quando Git existir.",
        "manifesto vazio, incompleto, duplicado, malformado ou inconsistente",
        "caminhos relativos únicos em ordem lexicográfica",
        "SHA-256 minúsculo do conteúdo ou `REMOVED`",
        "não invente hashes",
    ]
    for marker in manifest_markers:
        if marker not in contract:
            reject("R008_MANIFEST", f"runner manifest contract lacks: {marker}")

    attempt_markers = [
        "A primeira tentativa é `initial`; qualquer tentativa posterior é `revalidation`",
        "Confira o estado final completo da slice",
        "Registre comando e exit code; não esconda falhas.",
    ]
    for marker in attempt_markers:
        if marker not in contract:
            reject("R009_VALIDATION_ATTEMPT", f"runner attempt/evidence contract lacks: {marker}")

    overlap_markers = [
        "Effective Validation Base de slices anteriores",
        "valide o comportamento atual e regressões diretamente justificadas",
        "Inclua o path final no manifesto da slice atual.",
        "não reabra a slice anterior.",
    ]
    for marker in overlap_markers:
        if marker not in contract:
            reject("R010_OVERLAP", f"runner overlap contract lacks: {marker}")

    compact_markers = [
        "somente de forma compacta",
        "sem logs completos, transcrições extensas ou raciocínio privado",
        "Não invente resultados nem retorne raciocínio privado.",
    ]
    for marker in compact_markers:
        if marker not in contract:
            reject("R011_COMPACT_OUTPUT", f"runner compact-output contract lacks: {marker}")

    readme = read_text(root / "README.md", "R002_REGISTRY")
    readme_markers = [
        "slice-validate-codex.md",
        "slice-validate-claude.md",
        "não invocam este agente",
        "Não existe fallback",
        "Cada invocação gera uma Validation Attempt append-only.",
        "Somente `PASS` fornece o manifesto final completo",
        "Em revalidação",
    ]
    for marker in readme_markers:
        if marker not in readme:
            reject("R012_README", f"validation-runner README lacks: {marker}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", choices=("launchers", "validation-runner"))
    parser.add_argument("--root", required=True, type=Path, help="fixture root to validate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    try:
        if args.scope == "launchers":
            check_launcher_contract(root)
        else:
            check_runner_contract(root)
    except ContractViolation as exc:
        print(f"CONTRACT_ERROR[{exc.category}]: {exc}", file=sys.stderr)
        return 1
    except InfrastructureError as exc:
        print(f"INFRA_ERROR: {exc}", file=sys.stderr)
        return 2
    print(f"PASS: semantic {args.scope} contract: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
