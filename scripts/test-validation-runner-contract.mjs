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
  // The contract checker reads distributed sources, not SDK dependencies.
  await fs.cp(canonical, root, { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') });
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

test("formal coverage findings require a demonstrated authorized test-delivery defect without weakening PASS", async () => {
  for (const relative of ["codex/.codex/agents/stnl_validation_runner.toml", "claude-code/.claude/agents/stnl-validation-runner.md"]) {
    const contract = await fs.readFile(path.join(canonical, relative), "utf8");
    assert.match(contract, /defeito comprovado da entrega de testes já exigida pela autoridade atual[^\n]*paths aprovados da própria slice[^\n]*`NEEDS_FIX`[^\n]*finding de cobertura/u);
    assert.match(contract, /critério\/variante[^\n]*evidência direta[^\n]*path autorizado[^\n]*correção mínima/u);
    assert.match(contract, /ausência de prova, por si só, não identifica defeito corrigível/u);
    assert.match(contract, /Somente o executor corrige via `APPLY_FINDINGS`[^\n]*`VALIDATE_SLICE`[^\n]*budgets existentes/u);
    assert.match(contract, /Nunca retorne PASS enquanto algum critério aplicável estiver sem evidência suficiente/u);
  }
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  assert.match(quality, /demonstrated defect of executor-prepared tests already required by current authority[^\n]*authorized paths in this slice[^\n]*NEEDS_FIX/u);
  assert.match(quality, /Missing evidence alone does not establish a correctable test-delivery defect/u);
  const sdk = await fs.readFile(path.join(repository, "agents/codex/runtime/sdk-transport.mjs"), "utf8");
  assert.match(sdk, /For VALIDATE_SLICE only[^\n]*executor-prepared tests already required by current authority and authorized in this slice[\s\S]{0,80}NEEDS_FIX/u);
  assert.doesNotMatch(sdk, /Missing runnable coverage is BLOCKED;/u);
});

test("coverage review compares authority, effective input, assertion and producer in every instruction source", async () => {
  for (const relative of ['codex/.codex/agents/stnl_validation_runner.toml', 'claude-code/.claude/agents/stnl-validation-runner.md']) {
    const contract = await fs.readFile(path.join(canonical, relative), 'utf8');
    assert.match(contract, /Antes de alegar ausência de cobertura[^\n]*requisito\/variante[^\n]*entrada efetivamente gravada[^\n]*asserção esperada[^\n]*caminho produtor/u);
    assert.match(contract, /produtor pertinente no escopo[^\n]*transformações e chamadas/u);
    assert.match(contract, /Aponte paths e trechos ou valores observados[^\n]*separe requisito exigido de melhoria opcional/u);
    assert.match(contract, /julgamento semântico; o runtime não prova a validade de um finding/u);
  }
  for (const file of ['agents/codex/runtime/sdk-transport.mjs', 'skills/workflows/stnl-slice-quality-manager/SKILL.md']) {
    const instruction = await fs.readFile(path.join(repository, file), 'utf8');
    assert.match(instruction, /Before claiming coverage is absent[^\n]*current requirement\/variant[^\n]*input actually persisted[^\n]*expected assertion[^\n]*producer path/u);
    assert.match(instruction, /cite paths and observed values or excerpts/iu);
    assert.match(instruction, /Distinguish required coverage from optional improvements/u);
    assert.match(instruction, /semantic judgment/u);
  }
});

test("distribution gate rejects loss of coverage comparison without judging model findings", async (t) => {
  for (const [before, after] of [
    ['a entrada efetivamente gravada ou fornecida ao check', 'apenas a aparência da fixture'],
    ['a asserção esperada e o caminho produtor da entrada e do resultado', 'apenas o nome do teste'],
    ['considere suas transformações e chamadas', 'ignore transformações e chamadas'],
    ['Aponte paths e trechos ou valores observados', 'Aponte somente suspeitas'],
    ['separe requisito exigido de melhoria opcional', 'trate melhorias opcionais como requisitos'],
  ]) {
    const root = await fixture(t);
    await replaceBoth(root, before, after);
    expectCategory(check(root), 'R006_VERDICTS');
  }
});

test("offline coverage examples expose effective inputs and assertion limits, not LLM judgment", async (t) => {
  // Synthetic criterion: object round trip preserves Unicode, false and nested
  // null. Property order/JSON whitespace are not required. No verdict classifier
  // or model is invoked; all checks are prepared before executing any command.
  const required = { label: 'Ž', enabled: false, meta: { empty: null } };
  for (const kind of ['indirect-present', 'missing-required-variant', 'defective-assertion', 'optional-format']) {
    await t.test(kind, async child => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-coverage-example-'));
      child.after(() => fs.rm(root, { recursive: true, force: true }));
      await fs.writeFile(path.join(root, 'input-producer.mjs'), `export function input() {
        const seed = { label: 'Ž', enabled: true };
        return { ...seed, enabled: false, meta: ${kind === 'missing-required-variant' ? '{}' : '{ empty: null }'} };
      }\n`);
      await fs.writeFile(path.join(root, 'result-producer.mjs'), `export function roundTrip(value) {
        const output = JSON.parse(JSON.stringify(value));
        ${kind === 'defective-assertion' ? 'delete output.meta.empty;' : ''}
        return ${kind === 'optional-format' ? 'Object.fromEntries(Object.entries(output).reverse())' : 'output'};
      }\n`);
      await fs.writeFile(path.join(root, 'prepare.mjs'), `import fs from 'node:fs/promises';
        import { input } from './input-producer.mjs';
        await fs.writeFile('input.json', JSON.stringify(input()));\n`);
      const preamble = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
        import { roundTrip } from './result-producer.mjs';
        const input = JSON.parse(await fs.readFile('input.json', 'utf8')); const output = roundTrip(input);\n`;
      await fs.writeFile(path.join(root, 'prepared-check.mjs'), preamble + (kind === 'defective-assertion'
        ? "assert.equal(output.label, 'Ž');\n" : 'assert.deepEqual(output, input);\n'));
      await fs.writeFile(path.join(root, 'required-check.mjs'), preamble + `assert.deepEqual(input, ${JSON.stringify(required)});
        assert.deepEqual(output, ${JSON.stringify(required)});\n`);
      const run = file => spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' });
      assert.equal(run('prepare.mjs').status, 0);
      const recordedBytes = await fs.readFile(path.join(root, 'input.json'));
      const recorded = JSON.parse(recordedBytes);
      assert.equal(run('prepared-check.mjs').status, 0, 'a green prepared check alone does not decide coverage');
      const observed = run('required-check.mjs');
      assert.equal(observed.status, ['missing-required-variant', 'defective-assertion'].includes(kind) ? 1 : 0, observed.stderr);
      if (kind === 'missing-required-variant') assert.equal(Object.hasOwn(recorded.meta, 'empty'), false);
      else assert.deepEqual(recorded, required, 'inspect the effective input, including producer transformations');
      if (kind === 'defective-assertion') assert.match(observed.stderr, /deepEqual|deep-equal/u);
      if (kind === 'optional-format') {
        const { roundTrip } = await import(new URL('file://' + path.join(root, 'result-producer.mjs')));
        assert.notEqual(JSON.stringify(roundTrip(recorded)), JSON.stringify(required));
        assert.deepEqual(roundTrip(recorded), required, 'an unrequired serialization preference does not violate this criterion');
      }
      assert.deepEqual(await fs.readFile(path.join(root, 'input.json')), recordedBytes, 'checks preserve their input');
    });
  }
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

test("native VALIDATE_SLICE schema omits the check-run round marker", async () => {
  const codex = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  const claude = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const contract of [codex, claude]) {
    const schemaText = contract.match(/## Schema VALIDATE_SLICE\s+```json\n([\s\S]*?)\n```/u)?.[1];
    assert.ok(schemaText, "VALIDATE_SLICE schema is present");
    const schema = JSON.parse(schemaText);
    assert.deepEqual(Object.keys(schema), [
      "status", "head", "commands", "evidence", "findingReferences", "findingDispositions",
      "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
    ]);
    assert.doesNotMatch(schemaText, /automaticCheckRound/u);
    assert.match(contract, /only for `EXECUTE_SLICE` and `APPLY_FINDINGS`; omit this field from `VALIDATE_SLICE`, whose exact schema excludes it\./u);
  }
});

test("formal commands and requirement-bound findings cannot be weakened in the distributed contract", async (t) => {
  for (const [oldValue, newValue, category] of [
    ["Todo finding exige violação demonstrada de requisito ou variante da autoridade atual", "Todo finding pode ser uma preferência", "R006_VERDICTS"],
    ["Preferência por uma asserção mais forte ou por um formato não exigido não é defeito de cobertura", "Uma asserção preferida exige finding", "R006_VERDICTS"],
    ["Em VALIDATE_SLICE, `commands` é sempre um array não vazio", "Em VALIDATE_SLICE, `commands` pode estar vazio", "R009_VALIDATION_ATTEMPT"],
    ["nunca invente um comando, um exit ou um check", "invente um comando para completar o schema", "R009_VALIDATION_ATTEMPT"],
  ]) {
    const root = await fixture(t);
    await replaceBoth(root, oldValue, newValue);
    expectCategory(check(root), category);
  }
});

test("skills distinguish native runner evidence from managed receipts", async () => {
  const executor = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  const runner = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  assert.match(executor, /native invocation[^\n]*--semantic-response-file[^\n]*--insert-candidate[^\n]*no `--receipt-file`/u);
  assert.match(executor, /managed launches[^\n]*\$STNL_RUNNER_EVIDENCE_SERIALIZER[^\n]*if it is absent, block/u);
  assert.match(quality, /Omit `--receipt-file` in native mode/u);
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

test("runner contract forbids hiding a failed check after a corrected check passes", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "Um check marcado com exit não zero impede", "Ignore o check anterior para permitir");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("prepared check defects use bounded execution failures while unclassified formal and environmental blockers stay blocked", async () => {
  for (const relative of ["codex/.codex/agents/stnl_validation_runner.toml", "claude-code/.claude/agents/stnl-validation-runner.md"]) {
    const contract = await fs.readFile(path.join(canonical, relative), "utf8");
    assert.match(contract, /Em `EXECUTE_SLICE` e `APPLY_FINDINGS`,[^\n]*teste, fixture ou asserção preparado pelo executor[^\n]*correção possível dentro do escopo aprovado[^\n]*retorne `TESTS_FAIL`/u);
    assert.match(contract, /Não é necessário demonstrar defeito da implementação[^\n]*diagnóstico[^\n]*evidência/u);
    assert.match(contract, /O runner permanece read-only[^\n]*contexto principal[^\n]*três rodadas/u);
    assert.match(contract, /Fora dessa exceção, defeito do próprio script, fixture, quoting ou asserção[^\n]*`BLOCKED`/u);
    assert.match(contract, /Negação de sandbox ou permissão[^\n]*insumo realmente indisponível[^\n]*`BLOCKED`/u);
    assert.doesNotMatch(contract, /Se a falha é do próprio script, fixture, quoting ou asserção do check, retorne `BLOCKED`/u);
  }
  const executor = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(executor, /executor-prepared test, fixture or assertion[^\n]*`TESTS_FAIL`[^\n]*approved slice/u);
  assert.match(executor, /Sandbox or permission denial[^\n]*genuinely unavailable[^\n]*`BLOCKED`/u);
  assert.match(executor, /Build fixtures from the existing input and persistence contracts[^\n]*do not expand those contracts/u);
  assert.match(executor, /Additional automatic rounds occur only after `TESTS_FAIL` in round one or two and an authorized correction/u);
  assert.match(executor, /Never make a fourth automatic invocation/u);
});

test("contract gate rejects losing prepared-check taxonomy or environmental and formal boundaries", async (t) => {
  for (const [before, after] of [
    ["correção possível dentro do escopo aprovado e dos direitos existentes, retorne `TESTS_FAIL`", "correção possível dentro do escopo aprovado e dos direitos existentes, retorne `BLOCKED`"],
    ["Negação de sandbox ou permissão, ferramenta, dependência ou insumo realmente indisponível", "Qualquer fixture inválida"],
    ["Fora dessa exceção, defeito do próprio script, fixture, quoting ou asserção do check continua exigindo `BLOCKED`", "Fora dessa exceção, defeito do próprio script, fixture, quoting ou asserção do check permite PASS"],
  ]) {
    const root = await fixture(t);
    await replaceBoth(root, before, after);
    expectCategory(check(root), "R006_VERDICTS");
  }
});

test("contract gate rejects broadening coverage findings beyond demonstrated authorized delivery defects", async (t) => {
  for (const [before, after] of [
    ["preparada pelo executor nos paths aprovados da própria slice", "preparada em qualquer path de qualquer slice"],
    ["correção cabe no escopo aprovado e nos direitos existentes", "correção pode ampliar escopo ou direitos"],
    ["evidência direta do defeito ou da omissão", "suspeita sem evidência do defeito"],
    ["ausência de prova, por si só, não identifica defeito corrigível", "ausência de prova sempre identifica defeito corrigível"],
    ["Somente o executor corrige via `APPLY_FINDINGS`, seguido de `VALIDATE_SLICE`, nos budgets existentes", "O runner corrige diretamente sem budget"],
  ]) {
    const root = await fixture(t);
    await replaceBoth(root, before, after);
    expectCategory(check(root), "R006_VERDICTS");
  }
});

test("runner verifies an accessible missing variant instead of treating missing prior tests as impossibility", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "Não confunda ausência de teste prévio com impossibilidade de verificar.", "Bloqueie se faltar teste prévio.");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("runner schema repair cannot expand beyond the two empty finding sets", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "A única equivalência de tipo permitida é array vazio", "Converta livremente qualquer array");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});

test("runner cannot create scripts to fill missing coverage or retry a denied command", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "runner não cria nem edita scripts ou testes", "runner cria scripts novos");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
  const second = await fixture(t);
  await replaceBoth(second, "Não tente novamente por outro path, ferramenta, TMPDIR/TMPPREFIX ou modo de permissão",
    "Tente outro path após a negação");
  expectCategory(check(second), "R009_VALIDATION_ATTEMPT");
});

test("execution prepares coverage while plan review and validation stop on denied writes", async () => {
  const executor = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  const plan = await fs.readFile(path.join(repository, "skills/workflows/stnl-plan-reviewer/SKILL.md"), "utf8");
  const coverage = await fs.readFile(path.join(repository, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  const quality = await fs.readFile(path.join(repository, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  assert.match(executor, /Prepare reusable tests in the authorized implementation[^\n]*before delegation/u);
  assert.match(executor, /Include those tests in the final Changed Areas/u);
  assert.match(plan, /<PLANNER_SKILL_ROOT>\/templates\/slice-plan\.template\.md`, section `Requirements`/u);
  assert.match(coverage, /preparation must belong to this slice's authorized implementation and test paths/u);
  assert.match(coverage, /cannot supply missing evidence for an AC assigned here/u);
  for (const skill of [executor, plan, quality]) {
    assert.match(skill, /even (?:when|after|if)[^\n]*exit[^\n]*zero/u);
    assert.match(skill, /do not retry via another path, tool, temp setting or permission mode/iu);
  }
  assert.match(quality, /missing evidence without an identified correctable defect remain BLOCKED/u);
  assert.match(quality, /Never PASS from an old suite or before sufficient evidence/u);
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
