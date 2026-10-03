import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const checker = path.join(repository, "scripts/check-contracts.mjs");
const canonical = path.join(repository, "agents");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-runner-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "subagents");
  await fs.cp(canonical, root, { recursive: true });
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, "validation-runner", "--root", root], { encoding: "utf8" });
}

async function replaceBoth(root, oldValue, newValue) {
  for (const relative of ["codex/.codex/agents/stnl_validation_runner.toml", "claude-code/.claude/agents/stnl-validation-runner.md"]) {
    const file = path.join(root, relative);
    const before = await fs.readFile(file, "utf8");
    assert.ok(before.includes(oldValue), `missing mutation source: ${oldValue}`);
    await fs.writeFile(file, before.replace(oldValue, newValue));
  }
}

function expectCategory(result, category) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`));
}

test("accepts the canonical independent semantic runner", async (t) => {
  assert.equal(check(await fixture(t)).status, 0);
});

test("Codex and Claude bodies remain byte-identical and schemas are exact", async () => {
  const toml = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  const claude = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const contract of [toml, claude]) {
    assert.match(contract, /## Schema EXECUTE_SLICE[\s\S]*?"commands": \[\{"command": "<full command>", "exit": 0\}\]/u);
    assert.match(contract, /## Schema APPLY_FINDINGS[\s\S]*?"findingsVerified": "<semantic value>"/u);
    assert.match(contract, /## Schema VALIDATE_SLICE[\s\S]*?"findingDispositions": "<semantic value>"/u);
  }
});

test("skills distinguish native runner evidence from managed receipts", async () => {
  const executor = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  const runner = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  assert.match(executor, /native invocation[^\n]*--semantic-response-file[^\n]*--insert-candidate[^\n]*no `--receipt-file`/u);
  assert.match(executor, /managed launches[^\n]*\$STNL_RUNNER_EVIDENCE_SERIALIZER[^\n]*if it is absent, block/u);
  assert.match(quality, /omit it in native mode/u);
  assert.match(quality, /native rejection lacks that receipt-bound recovery/u);
  assert.match(runner, /delegação nativa sem recibo[^\n]*exit numérico observado/u);
});

test("native generic spawn loads the complete installed runner contract in an independent context", async () => {
  const executor = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  const guide = await fs.readFile(path.join(canonical, "README.md"), "utf8");
  const contract = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  assert.match(contract, /name = "stnl_validation_runner"[\s\S]*developer_instructions = """\nCONTRATO_CANONICO=stnl-validation-runner\/v11/u);
  for (const skill of [executor, quality]) {
    assert.match(skill, /fork_turns:"none"[^\n]*complete installed runner contract/u);
    assert.match(skill, /\.codex\/agents\/stnl_validation_runner\.toml` `developer_instructions`/u);
    assert.match(skill, /not a selected registered runner type/u);
    assert.match(skill, /task-level instruction loading; it does not confer developer-level priority or the enforcement guarantee of a registered agent/u);
    assert.match(skill, /instruct it to follow the contract's no-write rule/u);
    assert.match(skill, /without that contract is not the runner/u);
    assert.match(skill, /In managed mode use only[^\n]*STNL_MANAGED_RUNNER_BRIDGE/u);
  }
  assert.match(guide, /agente independente com contrato carregado, não uma seleção do tipo registrado/u);
  assert.match(guide, /instruções de tarefa, sem prioridade de developer nem a mesma garantia de aplicação do agente registrado/u);
  assert.match(guide, /Instrua o agente genérico a não editar código nem artefatos de execução/u);
});

test("mechanical authority, candidate and serializer details stay outside runner contract", async () => {
  const contract = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  assert.doesNotMatch(contract, /RUNNER_EVIDENCE_SERIALIZER|candidateTaskArtifact|path\.relative\(|sha256:/u);
  assert.match(contract, /runtime fornece identidade e campos mecânicos fora do payload/u);
  assert.match(contract, /Serialização, persistência e validação determinística pertencem ao runtime\/producer/u);
});

test("independence and read-only boundaries remain enforced", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "Trate conclusões do contexto principal como não verificadas.", "Aceite conclusões anteriores.");
  expectCategory(check(root), "R014_INDEPENDENCE");
});

test("semantic verdict and discovery requirements remain enforced", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED", "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|BLOCKED");
  expectCategory(check(root), "R006_VERDICTS");
});

test("malformed semantic response gate remains rejected", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "# Canonical response gate", "# Response gate");
  expectCategory(check(root), "R026_OUTPUT_GATE");
});

test("validation findings require canonical IDs and dispositions", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "IDs canônicos `finding-01`, `finding-02`", "IDs livres `F-001`, `F-002`");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("runner verdict precedes final manifest fields", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root,
    "A ausência ou o valor pending desses campos finais desta tentativa não é causa de BLOCKED.",
    "Exija todos os campos finais antes de decidir.");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("runner must check each acceptance criterion before PASS", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root,
    "Nunca retorne PASS enquanto algum critério aplicável estiver sem evidência suficiente",
    "Retorne PASS quando o teste focado passar");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("format repair contract forbids a changed verdict and uncertain-turn retry", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root,
    "Não use esse caminho para resposta semântica válida, timeout, processError ou conclusão incerta.",
    "Use o reparo também após timeout.");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("quality manager treats a yielded session as pending and preserves the first receipt", async () => {
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  assert.match(quality, /yielded a session ID[^\n]*pending, not an initialization or transport failure/u);
  assert.match(quality, /Do not start a second runner while the first is pending/u);
  assert.match(quality, /preserve the first valid receipt even if a later response differs/u);
  assert.match(quality, /SDK return with `processError`, timeout, or no `threadId`[^\n]*does not prove that no provider work began/u);
  assert.match(quality, /A thrown error after invoking `runTurn` or the broker's invoke callback is likewise uncertain/u);
  assert.match(quality, /Their pending state before that verdict is not a blocker/u);
  assert.match(quality, /every applicable acceptance criterion against concrete current implementation and check evidence/u);
  assert.match(quality, /at most one format-only correction in the same runner thread/u);
  assert.match(quality, /if the local equivalence check cannot prove unchanged content, stop with the malformed-result blocker/u);
});
