#!/usr/bin/env python3
"""Focused semantic contract checks for launchers and the three-operation runner."""

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
CODEX_EXECUTE_INSTRUCTIONS = (
    "Após implementar e registrar o escopo alterado, faça spawn obrigatoriamente para a primeira chamada ao agente customizado `stnl_validation_runner` com `OPERATION=EXECUTE_SLICE`, o SPEC path, execution root derivado, slice, paths de plans e tasks, evidências relevantes, escopo alterado, rodada automática e o contexto adicional aplicável. Invoque o runner no mínimo uma vez e no máximo três vezes nesta mesma operação manual, nas rodadas `1/3`, `2/3` e `3/3`; nunca faça uma quarta chamada nem use loop ilimitado. Não pule o runner por mudança simples nem por acreditar que nenhum check seja aplicável; a descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner.",
    "Não passe logs completos. Não execute no contexto principal testes, builds, linters, typechecks, compilações ou outros comandos de verificação. Aguarde cada retorno e persista-o append-only em `Implementation Test Evidence`, com o próximo `implementation-check-NN` global, rodada, descoberta de checks, justificativa de não aplicabilidade, estado, comandos, falhas, correções cobertas e escopo.",
    "Em `TESTS_FAIL` nas rodadas 1 ou 2, depois de persistir a evidência, corrija automaticamente no contexto principal somente a falha objetiva dentro do escopo aprovado, registre falha, evidência, alteração, arquivos, escopo atualizado e justificativa interna, e então chame o runner novamente. Na terceira falha, persista e encerre sem nova correção automática.",
    "Aceite somente `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`. Encerre em `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, `BLOCKED`, terceira falha ou decisão fora do escopo; mantenha a slice aberta e não crie Validation Attempt, Effective Validation Base ou conclusão `[x]`. `TESTS_NOT_APPLICABLE` exige descoberta objetiva, fontes e ações read-only resumidas, justificativa e nenhum comando de verificação executado; não o trate como `PASS` formal.",
    "Se o agente não iniciar ou retornar saída inválida, persista `BLOCKED` com a causa e encerre. Não faça fallback, não crie etapa manual de retry, não amplie escopo e não inicie `VALIDATE_SLICE` nem outra operação automaticamente.",
)
CLAUDE_EXECUTE_INSTRUCTIONS = (
    "Após implementar e registrar o escopo alterado, delegue obrigatoriamente a primeira chamada dos testes desta operação com `OPERATION=EXECUTE_SLICE`, o SPEC path, execution root derivado, slice, paths de plans e tasks, evidências relevantes, escopo alterado, rodada automática e o contexto adicional aplicável para:",
    "@agent-stnl-validation-runner",
    "Invoque o runner no mínimo uma vez e no máximo três vezes nesta mesma operação manual, nas rodadas `1/3`, `2/3` e `3/3`; nunca faça uma quarta chamada nem use loop ilimitado. Não pule o runner por mudança simples nem por acreditar que nenhum check seja aplicável; a descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner.",
    *CODEX_EXECUTE_INSTRUCTIONS[1:],
)
CODEX_FINDINGS_INSTRUCTIONS = (
    "Após aplicar os findings e registrar correções e escopo alterado, faça spawn obrigatoriamente para a primeira chamada ao agente customizado `stnl_validation_runner` com `OPERATION=APPLY_FINDINGS`, o SPEC path, execution root derivado, slice, paths de plans e tasks, findings pendentes, correções, evidências relevantes, escopo alterado, rodada automática e o contexto adicional aplicável. Invoque o runner no mínimo uma vez e no máximo três vezes nesta mesma operação manual, nas rodadas `1/3`, `2/3` e `3/3`; nunca faça uma quarta chamada nem use loop ilimitado. Não pule o runner por correção simples nem por acreditar que nenhum check seja aplicável; a descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner.",
    "Não passe logs completos. Não execute no contexto principal testes, builds, linters, typechecks, compilações ou outros comandos de verificação. Aguarde cada retorno e persista-o append-only em `Findings Test Evidence`, com o próximo `findings-check-NN` global, ciclo de findings, rodada, descoberta de checks, justificativa de não aplicabilidade, estado, comandos, falhas, correções cobertas e escopo.",
    "Em `TESTS_FAIL` nas rodadas 1 ou 2, depois de persistir a evidência, ajuste automaticamente no contexto principal somente findings persistidos, falhas introduzidas ou expostas pelas correções e regressões diretamente relacionadas dentro do escopo aprovado; registre falha, evidência, alteração, arquivos, correções e escopo atualizado, e então chame o runner novamente. Na terceira falha, persista, preserve os findings e encerre sem nova correção automática.",
    "Aceite somente `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`. Encerre em `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, `BLOCKED`, terceira falha ou decisão fora do escopo; preserve findings e Validation Attempts, mantenha a slice aberta e não crie Effective Validation Base ou conclusão `[x]`. `TESTS_NOT_APPLICABLE` exige descoberta objetiva, fontes e ações read-only resumidas, justificativa e nenhum comando de verificação executado e não resolve findings por si só.",
    "Se o agente não iniciar ou retornar saída inválida, persista `BLOCKED` com a causa e encerre. Não faça fallback, não marque findings como resolvidos sem sustentação, não crie etapa manual de retry, não amplie escopo e não inicie `VALIDATE_SLICE` nem outra operação automaticamente.",
)
CLAUDE_FINDINGS_INSTRUCTIONS = (
    "Após aplicar os findings e registrar correções e escopo alterado, delegue obrigatoriamente a primeira chamada dos testes desta operação com `OPERATION=APPLY_FINDINGS`, o SPEC path, execution root derivado, slice, paths de plans e tasks, findings pendentes, correções, evidências relevantes, escopo alterado, rodada automática e o contexto adicional aplicável para:",
    "@agent-stnl-validation-runner",
    "Invoque o runner no mínimo uma vez e no máximo três vezes nesta mesma operação manual, nas rodadas `1/3`, `2/3` e `3/3`; nunca faça uma quarta chamada nem use loop ilimitado. Não pule o runner por correção simples nem por acreditar que nenhum check seja aplicável; a descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner.",
    *CODEX_FINDINGS_INSTRUCTIONS[1:],
)
CODEX_VALIDATE_INSTRUCTIONS = (
    "Faça spawn do agente customizado `stnl_validation_runner` com `OPERATION=VALIDATE_SLICE`, o SPEC path, execution root derivado, slice, paths de plans e tasks, evidências de implementação e findings, incluindo `TESTS_NOT_APPLICABLE`, histórico de validação, escopo alterado, diff, overlaps e o contexto adicional aplicável.",
    "Não passe logs completos. Aguarde o retorno. O contexto principal somente adiciona a Validation Attempt e, em `PASS` válido, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.",
    "Exija revisão independente da descoberta e justificativa de qualquer `TESTS_NOT_APPLICABLE`; o runner pode rejeitar essa evidência, descobrir e executar check aplicável ou exigir inspeção adicional. Não promova não aplicabilidade a `PASS`; a validação formal continua somente `PASS | NEEDS_FIX | BLOCKED`.",
    "Se o agente não iniciar ou não retornar resultado válido, persista e retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.",
)
CLAUDE_VALIDATE_INSTRUCTIONS = (
    "Delegue obrigatoriamente a validação independente com `OPERATION=VALIDATE_SLICE`, o SPEC path, execution root derivado, slice, paths de plans e tasks, evidências de implementação e findings, incluindo `TESTS_NOT_APPLICABLE`, histórico de validação, escopo alterado, diff, overlaps e o contexto adicional aplicável para:",
    "@agent-stnl-validation-runner",
    *CODEX_VALIDATE_INSTRUCTIONS[1:],
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
    "spec-readiness": LauncherSpec(
        "stnl-spec-lifecycle-manager",
        "MODE",
        "READINESS",
        (
            ("SPEC_PATH", "{{SPEC_PATH}}"),
            ("READINESS_SCOPE", "{{READINESS_SCOPE}}"),
            ("READINESS_FOCUS", "{{READINESS_FOCUS}}"),
        ),
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
    "slice-execute-codex": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "EXECUTE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CODEX_EXECUTE_INSTRUCTIONS,
    ),
    "slice-execute-claude": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "EXECUTE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CLAUDE_EXECUTE_INSTRUCTIONS,
    ),
    "slice-apply-findings-codex": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "APPLY_FINDINGS",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CODEX_FINDINGS_INSTRUCTIONS,
    ),
    "slice-apply-findings-claude": LauncherSpec(
        "stnl-slice-executor",
        "OPERATION",
        "APPLY_FINDINGS",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CLAUDE_FINDINGS_INSTRUCTIONS,
    ),
    "execution-close": LauncherSpec(
        "stnl-execution-closer", "OPERATION", "CLOSE", (("SPEC_PATH", "{{SPEC_PATH}}"),)
    ),
    "slice-validate-codex": LauncherSpec(
        "stnl-slice-quality-manager",
        "OPERATION",
        "VALIDATE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CODEX_VALIDATE_INSTRUCTIONS,
    ),
    "slice-validate-claude": LauncherSpec(
        "stnl-slice-quality-manager",
        "OPERATION",
        "VALIDATE_SLICE",
        (("SPEC_PATH", "{{SPEC_PATH}}"), ("SLICE", "{{SLICE}}")),
        CLAUDE_VALIDATE_INSTRUCTIONS,
    ),
}

SHARED_EXECUTION = {
    "execution-plan",
    "execution-plan-review",
    "execution-tasks",
    "execution-tasks-review",
    "execution-close",
}

RUNNER_LAUNCHERS = {
    "slice-execute-codex",
    "slice-execute-claude",
    "slice-apply-findings-codex",
    "slice-apply-findings-claude",
    "slice-validate-codex",
    "slice-validate-claude",
}


def check_executor_contract(path: Path) -> None:
    text = read_text(path, "L014_AUTOMATIC_RECHECK")
    required_markers = [
        "Check every operation precondition before implementation or correction.",
        "Once implementation or correction has occurred, the operation cannot end without invoking the configured runner.",
        "Invoke the configured runner at least once and at most three times within the same manual operation.",
        "The first invocation is mandatory after the initial implementation or correction",
        "cannot be skipped because the change appears simple or because no check is expected to apply",
        "the runner performs independent discovery and returns `TESTS_NOT_APPLICABLE` when appropriate",
        "The operation may end after implementation or correction only after a valid auxiliary status is received or the runner fails to start or returns malformed output with an objective cause.",
        "Additional invocations occur only after `TESTS_FAIL` in round one or two and an authorized correction.",
        "Never make a fourth automatic invocation",
        "use an unbounded loop",
        "fall back to checks in the main context",
        "A later manual invocation has its own three-call budget but continues each section's sequence instead of resetting it.",
        "`TESTS_NOT_APPLICABLE` is valid only after objective discovery and when no verification command was executed",
        "read-only actions used only to discover applicable checks are permitted and recorded under `Check discovery sources`",
    ]
    for marker in required_markers:
        if marker not in text:
            reject("L014_AUTOMATIC_RECHECK", f"{path}: executor runner contract lacks: {marker}")

    preconditions = text.index("Check every operation precondition before implementation or correction.")
    implementation = text.index("After implementation or correction, determine the final changed and removed scope")
    invocation = text.index("Invoke the configured runner at least once and at most three times")
    if not preconditions < implementation < invocation:
        reject("L014_AUTOMATIC_RECHECK", f"{path}: executor does not order preconditions, implementation/correction, and mandatory first invocation")

    ambiguous_or_optional = [
        r"(?i)\bup to three times\b",
        r"(?i)\bzero to three (?:calls|invocations)\b",
        r"(?i)\brunner invocation is optional\b",
        r"(?i)\bmay invoke the runner\b",
        r"(?i)\binvoke (?:the )?runner when applicable\b",
        r"(?i)\boptionally invoke (?:the )?runner\b",
        r"(?i)\bskip the runner when no tests apply\b",
        r"(?i)\bno runner call is required\b",
    ]
    if any(re.search(pattern, text) for pattern in ambiguous_or_optional):
        reject("L014_AUTOMATIC_RECHECK", f"{path}: executor permits an optional or zero-call runner cycle")


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

        forbidden_removed = [
            "FINALIZE_SLICE",
            "PARALLELIZE_SLICES",
            "RUN_TESTS",
            "RETRY_TESTS",
            "FIX_TESTS",
            "TEST_SLICE",
            "TEST_FINDINGS",
            "VALIDATE_IMPLEMENTATION",
            "EXECUTE_SLICES",
        ]
        for token in forbidden_removed:
            if token in text:
                reject("L005_REMOVED_CONTRACT", f"{actual[name]}: removed operation remains: {token}")
        if "PLANNING" in text:
            reject("L005_REMOVED_CONTRACT", f"{actual[name]}: removed lifecycle mode remains: PLANNING")
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
            r"stnl[_-]validation[_-]runner|@agent-|Claude|Codex|\bspawn\b|\bdeleg", text, re.IGNORECASE
        ):
            reject("L006_SHARED_ISOLATION", f"{actual[name]}: shared launcher contains a platform identity")
        if name == "execution-close" and re.search(
            r"runner|spawn|deleg|testes?|builds?|linters?|typechecks?|compila|retry|correç", text, re.IGNORECASE
        ):
            reject("L006_SHARED_ISOLATION", f"{actual[name]}: CLOSE invokes a runner or verification command")

        if name in RUNNER_LAUNCHERS and name.endswith("-codex"):
            if text.count("stnl_validation_runner") != 1 or "@agent-" in text or "Claude" in text:
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: invalid Codex runner identity")
            if not instructions or "faça spawn" not in instructions[0].lower():
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: required Codex spawn invocation is missing")
        elif name in RUNNER_LAUNCHERS and name.endswith("-claude"):
            if text.splitlines().count("@agent-stnl-validation-runner") != 1 or "stnl_validation_runner" in text or "Codex" in text:
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: invalid Claude runner identity")
            if len(instructions) < 2 or "delegue obrigatoriamente" not in instructions[0].lower():
                reject("L007_PLATFORM_IDENTITY", f"{actual[name]}: mandatory Claude delegation is missing")

        if spec.operation in {"EXECUTE_SLICE", "APPLY_FINDINGS"}:
            evidence_section = (
                "Implementation Test Evidence" if spec.operation == "EXECUTE_SLICE" else "Findings Test Evidence"
            )
            required_flow = {
                f"`OPERATION={spec.operation}`": "runner operation is not passed",
                "execution root derivado": "derived execution root is not passed",
                "paths de plans e tasks": "plan/task paths are not passed",
                "escopo alterado": "changed scope is not passed",
                "Não passe logs completos": "full-log forwarding is not prohibited",
                "Não execute no contexto principal testes": "main context may execute checks",
                evidence_section: "compact evidence destination is missing",
                "`TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`": "check statuses are not exact",
                "mantenha a slice aberta": "check may close the slice",
                "Não faça fallback": "fallback is not prohibited",
                "no mínimo uma vez e no máximo três vezes": "minimum and maximum runner-invocation budget is missing",
                "primeira chamada": "mandatory first runner invocation after implementation or correction is missing",
                "Não pule o runner": "runner bypass for simple or apparently non-applicable changes is not prohibited",
                "descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner": "non-applicability may bypass independent runner discovery",
                "rodadas `1/3`, `2/3` e `3/3`": "automatic rounds are missing",
                "nunca faça uma quarta chamada": "fourth automatic invocation is not prohibited",
                "nem use loop ilimitado": "unbounded loop is not prohibited",
                "persista-o append-only": "each automatic round is not append-only",
                "Em `TESTS_FAIL` nas rodadas 1 ou 2": "automatic correction after early TESTS_FAIL is missing",
                "e então chame o runner novamente": "automatic recheck after correction is missing",
                "Na terceira falha": "third-failure termination is missing",
                "sem nova correção automática": "third failure may still trigger correction",
                "não crie etapa manual de retry": "manual retry step is not prohibited",
                "não inicie `VALIDATE_SLICE`": "automatic formal validation is not prohibited",
                "`TESTS_NOT_APPLICABLE` exige descoberta objetiva, fontes e ações read-only resumidas, justificativa e nenhum comando de verificação executado": "non-applicability evidence is incomplete",
            }
            for marker, description in required_flow.items():
                if marker not in text:
                    category = "L014_AUTOMATIC_RECHECK" if any(
                        token in description
                        for token in ["minimum and maximum", "mandatory first", "runner bypass", "non-applicability may bypass", "automatic round", "fourth", "unbounded", "automatic correction", "automatic recheck", "third-failure", "third failure", "manual retry", "automatic formal"]
                    ) else "L012_CHECK_DELEGATION"
                    reject(category, f"{actual[name]}: {description}")
            if re.search(r"(?i)(?:exatamente|somente) uma (?:vez|chamada)", text):
                reject("L014_AUTOMATIC_RECHECK", f"{actual[name]}: runner is limited to one invocation")
            ambiguous_or_optional = [
                r"(?i)\bup to three times\b",
                r"(?i)\bzero to three (?:calls|invocations)\b",
                r"(?i)\brunner invocation is optional\b",
                r"(?i)\bmay invoke the runner\b",
                r"(?i)\bskip the runner when no tests apply\b",
                r"(?i)\bno runner call is required\b",
                r"(?i)\bpode invocar o runner\b",
                r"(?i)\bchamada (?:ao|do) runner (?:é|e) opcional\b",
                r"(?i)(?<!não )\bpule o runner (?:quando|se)\b",
            ]
            if any(re.search(pattern, text) for pattern in ambiguous_or_optional):
                reject("L014_AUTOMATIC_RECHECK", f"{actual[name]}: runner invocation is optional or permits zero calls")
            if "no máximo três vezes" in text and "no mínimo uma vez" not in text:
                reject("L014_AUTOMATIC_RECHECK", f"{actual[name]}: maximum runner budget lacks an explicit minimum")
            if (
                "faça uma quarta chamada" in text.lower()
                and "nunca faça uma quarta chamada" not in text.lower()
            ) or (
                "use loop ilimitado" in text.lower()
                and "nem use loop ilimitado" not in text.lower()
            ):
                reject("L014_AUTOMATIC_RECHECK", f"{actual[name]}: automatic recheck loop exceeds the bounded budget")
            formal_pass = re.search(r"(?im)^(?:emita|retorne|promova|trate)\b[^\n]{0,80}\bPASS\b", text)
            creates_attempt = re.search(r"(?<!não )crie Validation Attempt", text, re.IGNORECASE)
            creates_base = re.search(r"(?<!não )crie Effective Validation Base", text, re.IGNORECASE)
            completes = re.search(r"(?<!não )(?:marque|crie|defina).{0,30}`\[x\]`", text, re.IGNORECASE)
            if formal_pass or creates_attempt or creates_base or completes:
                reject("L013_CHECK_AUTHORITY", f"{actual[name]}: check launcher claims formal validation authority")
            if "trate-o como `PASS` formal" in text or "promova `TESTS_NOT_APPLICABLE` a `PASS`" in text:
                reject("L013_CHECK_AUTHORITY", f"{actual[name]}: TESTS_NOT_APPLICABLE is promoted to formal PASS")

        if spec.operation == "APPLY_FINDINGS":
            for marker in ["preserve findings", "não marque findings como resolvidos sem sustentação"]:
                if marker not in text:
                    reject("L013_CHECK_AUTHORITY", f"{actual[name]}: findings failure handling is incomplete")

        if spec.operation == "VALIDATE_SLICE":
            required_flow = {
                "Não faça fallback": "fallback is prohibited",
                "não repete testes": "main context must not rerun tests",
                "não refaz a validação": "main context must not redo validation",
                "não emite outro veredito": "main context must not emit another verdict",
                "substitui a Effective Validation Base e finaliza a slice": "PASS must update the base and finalize",
                "persista e retorne `BLOCKED`": "invalid runner return must remain BLOCKED",
                "`OPERATION=VALIDATE_SLICE`": "runner operation is not passed",
                "execution root derivado": "derived execution root is not passed",
                "evidências de implementação e findings": "prior test evidence is not passed",
                "Não passe logs completos": "full-log forwarding is not prohibited",
                "incluindo `TESTS_NOT_APPLICABLE`": "non-applicability evidence is not passed",
                "Exija revisão independente da descoberta e justificativa": "non-applicability is not reviewed independently",
                "pode rejeitar essa evidência": "omitted applicable checks cannot reject non-applicability",
                "Não promova não aplicabilidade a `PASS`": "non-applicability may be promoted to PASS",
                "somente `PASS | NEEDS_FIX | BLOCKED`": "formal validation statuses changed",
            }
            for marker, description in required_flow.items():
                if marker not in text:
                    reject("L008_VALIDATION_FLOW", f"{actual[name]}: {description}")

        if instructions != list(spec.instructions):
            reject("L010_CANONICAL_CONTENT", f"{actual[name]}: launcher instructions are not canonical")

    runner_mentions = {
        name for name, text in texts.items() if re.search(r"runner|@agent-|spawn|deleg", text, re.IGNORECASE)
    }
    if runner_mentions != RUNNER_LAUNCHERS:
        reject("L006_SHARED_ISOLATION", f"automatic runner invocation mismatch: {sorted(runner_mentions)}")


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
CHECK_SCHEMAS = {
    "EXECUTE_SLICE": [
        "Operação: EXECUTE_SLICE",
        "Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",
        "Automatic check round:",
        "HEAD:",
        "Escopo verificado:",
        "Estado testado:",
        "Check discovery sources:",
        "Verification types considered:",
        "Non-applicability rationale:",
        "No verification-command confirmation:",
        "Comandos executados:",
        "Resultado de cada comando e exit code:",
        "Testes selecionados:",
        "Justificativa da seleção:",
        "Cobertura:",
        "Falhas:",
        "Correções cobertas:",
        "Evidências ou resumo da falha:",
        "Arquivos ou comportamentos afetados:",
        "Bloqueios:",
        "Efeitos inesperados no workspace:",
        "Resumo para persistência:",
    ],
    "APPLY_FINDINGS": [
        "Operação: APPLY_FINDINGS",
        "Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",
        "Automatic check round:",
        "Ciclo de findings:",
        "HEAD:",
        "Escopo verificado:",
        "Estado testado:",
        "Check discovery sources:",
        "Verification types considered:",
        "Non-applicability rationale:",
        "No verification-command confirmation:",
        "Comandos executados:",
        "Resultado de cada comando e exit code:",
        "Testes selecionados:",
        "Justificativa da seleção:",
        "Cobertura:",
        "Findings verificados:",
        "Correções cobertas:",
        "Regressões selecionadas:",
        "Findings ainda não sustentados pelos testes:",
        "Falhas:",
        "Evidências ou resumo da falha:",
        "Arquivos ou comportamentos afetados:",
        "Bloqueios:",
        "Efeitos inesperados no workspace:",
        "Resumo para persistência:",
    ],
}
VALIDATION_SCHEMA = [
    "Operação: VALIDATE_SLICE",
    "Tipo de validação: initial | revalidation",
    "Status: PASS | NEEDS_FIX | BLOCKED",
    "Escopo verificado:",
    "HEAD:",
    "Evidências anteriores avaliadas:",
    "Atualidade e suficiência das evidências:",
    "Manifesto final da slice:",
    "Comandos executados:",
    "Resultado de cada comando e exit code:",
    "Testes selecionados ou repetidos:",
    "Justificativa da seleção ou repetição:",
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


def extract_output_schema(contract: str, operation: str) -> list[str]:
    match = re.search(
        rf"## Schema {re.escape(operation)}\n\n```text\n(.*?)```",
        contract,
        re.DOTALL,
    )
    if not match:
        reject("R007_OUTPUT_SCHEMA", f"runner output schema block is missing: {operation}")
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

    expected_description = "Runner barato e isolado para checks de implementação, checks de findings e validação formal independente de uma slice."
    if (
        codex.get("name") != "stnl_validation_runner"
        or codex.get("description") != expected_description
        or codex.get("model") != "gpt-5.4-mini"
        or codex.get("model_reasoning_effort") != "medium"
        or codex.get("sandbox_mode") != "workspace-write"
    ):
        reject("R001_ADAPTER_METADATA", "Codex validation-runner identity/model/effort/sandbox changed")
    if codex.get("agents") != {"max_depth": 1}:
        reject("R001_ADAPTER_METADATA", "Codex validation runner permits nested agents")
    expected_claude = {
        "name": "stnl-validation-runner",
        "description": expected_description,
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

    if contract.count("CONTRATO_CANONICO=stnl-validation-runner/v5") != 1:
        reject("R013_SYNTAX", "runner canonical contract identifier is missing or duplicated")
    operation_match = re.search(r"(?m)^OPERACOES_SUPORTADAS=([^\n]+)$", contract)
    if not operation_match:
        reject("R004_OPERATION_SCOPE", "runner supported-operation declaration is missing")
    operations = operation_match.group(1).split("|")
    expected_operations = ["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]
    if operations != expected_operations:
        reject("R004_OPERATION_SCOPE", f"runner operations must be exactly {expected_operations}; found={operations}")
    for forbidden_heading in ["CLOSE", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "RUN_TESTS", "EXECUTE_SLICES"]:
        if re.search(rf"(?m)^# {re.escape(forbidden_heading)}$|^## Schema {re.escape(forbidden_heading)}$", contract):
            reject("R004_OPERATION_SCOPE", f"runner supports forbidden operation: {forbidden_heading}")
    for marker in [
        "`EXECUTE_SLICE` e `APPLY_FINDINGS` também informam a rodada automática atual como `1/3`, `2/3` ou `3/3`",
        "o contador pertence à operação manual atual e não autoriza uma quarta invocação",
    ]:
        if marker not in contract:
            reject("R004_OPERATION_SCOPE", f"runner automatic-round input contract lacks: {marker}")

    independence_markers = [
        "Trate conclusões do contexto principal como não verificadas.",
        "Leia somente o escopo necessário",
        "confira diretamente planos, tasks, requisitos referenciados, diff, código, testes, evidências e dependências aplicáveis.",
        "Não confie apenas em checkboxes ou em resultados anteriores.",
    ]
    for marker in independence_markers:
        if marker not in contract:
            reject("R014_INDEPENDENCE", f"runner independence contract lacks: {marker}")

    read_only_markers = [
        "Não implemente, não corrija, não finalize e não persista em artefatos de execução.",
        "Não crie subagentes nem delegue.",
        "Não edite código, testes, requisitos, planos ou tasks.",
        "Não aplique correções",
        "não implemente findings",
        "nunca o reverta automaticamente",
        "O contexto principal é o único responsável por persistir sua saída compacta.",
    ]
    for marker in read_only_markers:
        if marker not in contract:
            reject("R005_READ_ONLY", f"validation runner lacks prohibition: {marker}")

    if "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED" not in contract:
        reject("R006_VERDICTS", "check statuses are not exactly TESTS_PASS, TESTS_FAIL, TESTS_NOT_APPLICABLE, and BLOCKED")
    check_markers = [
        "`TESTS_PASS` exige que todos os comandos selecionados tenham exit code zero",
        "`TESTS_FAIL` exige comandos que falharam, exit codes, resumo compacto",
        "`BLOCKED` exige impossibilidade objetiva, causa concreta e ação requerida",
        "Checks nunca emitem `PASS` formal, manifesto final autoritativo, Validation Attempt, Effective Validation Base, resultado final ou conclusão `[x]`.",
        "Não corrija automaticamente código quando um check falhar.",
    ]
    for marker in check_markers:
        if marker not in contract:
            reject("R015_CHECK_AUTHORITY", f"runner check contract lacks: {marker}")
    non_applicable_markers = [
        "Discovery actions são ações read-only usadas somente para determinar quais checks existem, quais comandos são autoritativos e se algum check se aplica ao escopo.",
        "Leitura, Glob, Grep, listagem, inspeção de manifests, CI, scripts, Makefiles, testes próximos e comandos read-only como `git status`, `git diff`, `find`, `rg` ou equivalentes são permitidos; não contam como verification commands.",
        "Fontes e métodos relevantes da descoberta devem aparecer em `Check discovery sources`",
        "Uma ferramenta read-only usada para descoberta não invalida `TESTS_NOT_APPLICABLE`",
        "qualquer efeito inesperado no workspace deve ser reportado",
        "Verification commands são comandos destinados a verificar a implementação ou correção",
        "Descubra checks autoritativos antes de escolher um status.",
        "scripts do projeto, documentação de desenvolvimento, convenções do repositório, CI, package manifests, Makefiles, task runners, testes próximos ao escopo, validators disponíveis e builds, linters ou typechecks aplicáveis",
        "`TESTS_NOT_APPLICABLE` é permitido somente em `EXECUTE_SLICE` ou `APPLY_FINDINGS` quando o runner foi efetivamente invocado, executou descoberta objetiva e demonstrou que nenhum verification command é aplicável ao escopo.",
        "Registre escopo analisado, fontes consultadas, ações read-only relevantes, tipos considerados, motivo objetivo, confirmação de que nenhum verification command foi executado",
        "`Comandos executados` e `Resultado de cada comando e exit code` devem declarar que nenhum verification command foi executado",
        "discovery actions não são registradas como comandos de teste",
        "Nunca retorne `TESTS_NOT_APPLICABLE` sem a invocação e a descoberta do runner, nem quando algum verification command tiver sido executado.",
        "Falha de verification command é `TESTS_FAIL`",
        "check aplicável que não pode ser executado por ferramenta, credencial, dependência externa, ambiente, serviço, permissão ou comando autoritativo objetivamente indisponível é `BLOCKED`",
        "A ausência objetiva de qualquer verification command aplicável, sem omitir check aplicável, é a única base de `TESTS_NOT_APPLICABLE`.",
    ]
    for marker in non_applicable_markers:
        if marker not in contract:
            reject("R016_NOT_APPLICABLE", f"runner non-applicability contract lacks: {marker}")
    forbidden_non_applicable = [
        r"(?i)nenhuma (?:ação|operação) de descoberta (?:é|e) permitida",
        r"(?i)zero operações de leitura",
        r"(?i)(?:leitura|grep|glob).{0,40}(?:conta|é|e|são) (?:como )?verification command",
        r"(?i)verification command.{0,60}(?:pode|may) .{0,20}TESTS_NOT_APPLICABLE",
    ]
    if any(re.search(pattern, contract) for pattern in forbidden_non_applicable):
        reject("R016_NOT_APPLICABLE", "runner confuses discovery actions with verification commands or permits invalid non-applicability")
    execute_match = re.search(r"# EXECUTE_SLICE\n(.*?)# APPLY_FINDINGS\n", contract, re.DOTALL)
    findings_match = re.search(r"# APPLY_FINDINGS\n(.*?)# VALIDATE_SLICE\n", contract, re.DOTALL)
    if not execute_match or not findings_match:
        reject("R004_OPERATION_SCOPE", "runner operation contract section is missing")
    execute_contract = execute_match.group(1)
    findings_contract = findings_match.group(1)
    for operation, operation_contract in {
        "EXECUTE_SLICE": execute_contract,
        "APPLY_FINDINGS": findings_contract,
    }.items():
        for forbidden in ["Validation Attempt", "Effective Validation Base", "manifesto final autoritativo", "conclusão `[x]`"]:
            if forbidden in operation_contract:
                reject("R015_CHECK_AUTHORITY", f"{operation} claims formal authority: {forbidden}")
        if re.search(r"(?<!TESTS_)`?PASS`? formal", operation_contract):
            reject("R006_VERDICTS", f"{operation} uses formal PASS instead of a check status")

    if "STATUS_VALIDACAO=PASS|NEEDS_FIX|BLOCKED" not in contract:
        reject("R006_VERDICTS", "formal validation statuses are not exactly PASS, NEEDS_FIX, and BLOCKED")
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
    validation_non_applicable_markers = [
        "Para `TESTS_NOT_APPLICABLE`, revise independentemente ações de descoberta, fontes consultadas, tipos considerados, justificativa e escopo atual",
        "rejeite a não aplicabilidade quando descobrir verification command aplicável omitido",
        "ausência de ferramenta tiver sido confundida com ausência de aplicabilidade",
        "execute verificação proporcional ou inspeção estática adicional quando necessária",
    ]
    for marker in validation_non_applicable_markers:
        if marker not in contract:
            reject("R016_NOT_APPLICABLE", f"formal validation does not independently review non-applicability: {marker}")

    for operation, expected_schema in CHECK_SCHEMAS.items():
        schema = extract_output_schema(contract, operation)
        if schema != expected_schema:
            reject("R007_OUTPUT_SCHEMA", f"runner {operation} schema differs; expected={expected_schema}, actual={schema}")
    validation_schema = extract_output_schema(contract, "VALIDATE_SLICE")
    if validation_schema != VALIDATION_SCHEMA:
        reject("R007_OUTPUT_SCHEMA", f"runner validation schema differs; expected={VALIDATION_SCHEMA}, actual={validation_schema}")

    execute_schema = CHECK_SCHEMAS["EXECUTE_SLICE"]
    findings_schema = CHECK_SCHEMAS["APPLY_FINDINGS"]
    common_check_fields = [field for field in execute_schema if field not in {"Operação: EXECUTE_SLICE"}]
    for field in common_check_fields:
        if field not in findings_schema and not field.startswith("Status:"):
            reject("R007_OUTPUT_SCHEMA", f"APPLY_FINDINGS schema is incompatible with EXECUTE_SLICE: {field}")
    for field in [
        "Findings verificados:",
        "Correções cobertas:",
        "Regressões selecionadas:",
        "Findings ainda não sustentados pelos testes:",
    ]:
        if field not in findings_schema:
            reject("R007_OUTPUT_SCHEMA", f"APPLY_FINDINGS schema lacks: {field}")

    manifest_markers = [
        "Somente em `VALIDATE_SLICE`, capture o `HEAD` atual quando Git existir.",
        "manifesto vazio, incompleto, duplicado, malformado ou inconsistente",
        "caminhos relativos únicos em ordem lexicográfica",
        "SHA-256 minúsculo do conteúdo ou `REMOVED`",
        "não invente hashes",
    ]
    for marker in manifest_markers:
        if marker not in contract:
            reject("R008_MANIFEST", f"runner manifest contract lacks: {marker}")

    attempt_markers = [
        "A primeira tentativa é `initial`; toda posterior é `revalidation`",
        "Realize validação formal independente do estado final completo da slice.",
        "execute ou repita checks proporcionalmente quando estado, autoridade, cobertura ou risco exigir.",
        "Reutilize evidência atual apenas para evitar repetição injustificada",
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
        "Não invente comandos, resultados, hashes ou raciocínio.",
    ]
    for marker in compact_markers:
        if marker not in contract:
            reject("R011_COMPACT_OUTPUT", f"runner compact-output contract lacks: {marker}")

    readme = read_text(root / "README.md", "R002_REGISTRY")
    readme_markers = [
        "slice-execute-codex.md",
        "slice-execute-claude.md",
        "slice-apply-findings-codex.md",
        "slice-apply-findings-claude.md",
        "slice-validate-codex.md",
        "slice-validate-claude.md",
        "aceita exatamente três operações internas",
        "Não existe passo manual adicional de testes.",
        "Não existe fallback",
        "Implementation Test Evidence",
        "Findings Test Evidence",
        "Somente `VALIDATE_SLICE` cria uma Validation Attempt.",
        "Somente um `PASS` formal atual",
        "`CLOSE` permanece read-only e não usa o runner, não executa testes",
        "`gpt-5.4-mini` com effort `medium`",
        "Haiku com effort `medium`",
        "no mínimo uma vez e no máximo três vezes",
        "a primeira chamada é obrigatória",
        "o runner sempre faz a descoberta independente",
        "Não existe quarta chamada, loop ilimitado, operação manual de retry",
        "`TESTS_NOT_APPLICABLE` representa somente descoberta objetiva",
        "Discovery actions são leituras e comandos read-only",
        "não contam como verification commands",
        "nenhum verification command pode ter sido executado",
        "não cria um novo passo manual",
        "O contexto principal continua sem executar checks",
        "Uma invocação manual posterior continua a numeração.",
        "revisa independentemente a descoberta e a justificativa",
        "não faz retry nem aplica correções",
    ]
    for marker in readme_markers:
        if marker not in readme:
            reject("R012_README", f"validation-runner README lacks: {marker}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", choices=("launchers", "validation-runner"))
    parser.add_argument("--root", required=True, type=Path, help="fixture root to validate")
    parser.add_argument(
        "--executor",
        type=Path,
        help="executor SKILL.md fixture; defaults to the repository canonical executor for launcher checks",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    try:
        if args.scope == "launchers":
            executor = args.executor or Path(__file__).resolve().parents[1] / "skills/stnl-slice-executor/SKILL.md"
            check_executor_contract(executor.resolve())
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
