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

async function replace(file, oldValue, newValue) {
  const before = await fs.readFile(file, "utf8");
  assert.ok(before.includes(oldValue), `missing mutation source in ${file}: ${oldValue}`);
  await fs.writeFile(file, before.replace(oldValue, newValue), "utf8");
}

async function replaceBoth(root, oldValue, newValue) {
  await replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), oldValue, newValue);
  await replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), oldValue, newValue);
}

function expectCategory(result, category) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`, "u"));
}

test("accepts canonical runner adapters with ignored metadata", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "codex/.codex/agents/.DS_Store"), "ignored\n");
  assert.equal(check(root).status, 0);
});

test("accepts harmless runner prose paraphrasing", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "Não recomende trabalho fora do escopo.", "Evite recomendar trabalho além do escopo autorizado.");
  assert.equal(check(root).status, 0, check(root).stderr);
});

test("runner documents structured findings and correction-path persistence grammar", async (t) => {
  const root = await fixture(t);
  const contract = await fs.readFile(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  assert.match(contract, /Findings verified[\s\S]{0,160}subconjunto canônico[\s\S]{0,120}Finding IDs[\s\S]{0,180}Unsupported active findings[\s\S]{0,180}exatamente os findings ativos[\s\S]{0,180}nunca se sobrepõem/u);
  assert.match(contract, /caminhos de correção[\s\S]{0,260}normalizados[\s\S]{0,160}comma-space[\s\S]{0,100}correção fileless[\s\S]{0,80}Correction paths[\s\S]{0,60}exact `none`/u);
});

test("VALIDATE_SLICE keeps the official preflight in the deterministic producer and rejects mechanical abbreviations", async () => {
  const contract = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  assert.match(contract, /`commands` deve reproduzir somente cada verification command[^\n]{0,420}producer determinístico insere o preflight oficial completo/iu);
  assert.match(contract, /não abrevie argumentos[^\n]{0,120}`\.\.\.`/iu);
  assert.match(contract, /retorne `BLOCKED`[^\n]{0,180}não corrija/iu);

  const observedMalformed = "- `node /repo/validate-execution-state.mjs ... VALIDATE_SLICE 1` — exit: 0";
  const expectedExact = "- `node /repo/validate-execution-state.mjs /tmp/workspace/spec VALIDATE_SLICE 1` — exit: 0";
  const containsCommandAbbreviation = (line) => /`[^`]*(?:\.\.\.|<SPEC_PATH>)[^`]*`/u.test(line);
  assert.equal(containsCommandAbbreviation(expectedExact), false);
  assert.equal(containsCommandAbbreviation(observedMalformed), true);
});

test("runner schemas use the canonical execution-record field labels", async () => {
  const contracts = await Promise.all([
    fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
    fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
  ]);
  for (const contract of contracts) {
    assert.match(contract, /## Schema EXECUTE_SLICE[\s\S]*?"status": "TESTS_PASS \| TESTS_FAIL \| TESTS_NOT_APPLICABLE \| BLOCKED"[\s\S]*?"head": "<semantic value>"[\s\S]*?"discoverySources": "<semantic value>"[\s\S]*?"commands": \[\{"command": "<full command>", "exit": 0\}\][\s\S]*?"selectedChecks":/u);
    assert.match(contract, /## Schema APPLY_FINDINGS[\s\S]*?"status": "TESTS_PASS \| TESTS_FAIL \| TESTS_NOT_APPLICABLE \| BLOCKED"[\s\S]*?"findingsCycle": "<semantic value>"[\s\S]*?"head": "<semantic value>"[\s\S]*?"discoverySources": "<semantic value>"[\s\S]*?"commands": \[\{"command": "<full command>", "exit": 0\}\][\s\S]*?"selectedChecks":/u);
    assert.match(contract, /## Schema VALIDATE_SLICE[\s\S]*?"status": "PASS \| NEEDS_FIX \| BLOCKED"[\s\S]*?"head": "<semantic value>"[\s\S]*?"commands": \[\{"command": "<full command>", "exit": 0\}\][\s\S]*?"findingReferences": "<semantic value>"[\s\S]*?"findingDispositions": "<semantic value>"/u);
    assert.doesNotMatch(contract, /(?:^|\n)(?:Operação|Escopo verificado|Estado testado|Comandos executados|Testes selecionados|Tipo de validação):/u);
  }
});

test("runner captures a real Git HEAD for every operation despite harmless Git stderr", async () => {
  for (const relative of ["codex/.codex/agents/stnl_validation_runner.toml", "claude-code/.claude/agents/stnl-validation-runner.md"]) {
    const contract = await fs.readFile(path.join(canonical, relative), "utf8");
    assert.match(contract, /Em `EXECUTE_SLICE`, `APPLY_FINDINGS` e `VALIDATE_SLICE`, capture o `HEAD` atual com `git rev-parse HEAD`/u);
    assert.match(contract, /exit 0 e uma linha stdout com exatamente 40 hex minúsculos[\s\S]{0,180}avisos de cache\/FSEvents em stderr/u);
    assert.match(contract, /nunca retorne `TESTS_PASS` com `head` vazio, placeholder ou diagnóstico em vez de SHA/u);
  }
});

test("VALIDATE_SLICE writes the exact payload SPEC_PATH into formal command evidence", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "com o `SPEC_PATH` exato",
    "com um `SPEC_PATH` aproximado",
  );
  expectCategory(check(root), "R020_EXACT_COMMANDS");
});

test("VALIDATE_SLICE requires the producer-owned official preflight invocation", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "producer determinístico insere o preflight oficial completo como primeiro item do bundle final",
    "producer determinístico pode omitir o preflight oficial do bundle final",
  );
  expectCategory(check(root), "R020_EXACT_COMMANDS");
});

test("runner requires task-relative Tested state paths before returning a status", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "Antes de retornar qualquer status, para cada entrada file-backed de `Tested state`, recompute mecanicamente",
    "Antes de retornar qualquer status, omita a base task-relative e recompute mecanicamente",
  );
  expectCategory(check(root), "R021_PATH_BASIS");
});

test("runner cannot use a raw requirements digest as auxiliary authority", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "um raw digest não é authority e não pode bloquear",
    "um raw digest é authority e pode bloquear",
  );
  expectCategory(check(root), "R022_AUTHORITY_IDENTITY");
});

test("runner consumes the launcher-owned exact recovery preflight instead of reconstructing its mechanical CLI input", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "Não invoque nem reconstrua esse comando no modelo.",
    "Reconstrua o comando de preflight no modelo.",
  );
  expectCategory(check(root), "R019_REQUIREMENTS_AUTHORITY");
});

test("runner must verify task-relative claims resolve to the physical target", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "compare por `realpath`",
    "compare por uma aproximação",
  );
  expectCategory(check(root), "R023_PHYSICAL_PATH_IDENTITY");
});

test("runner must fail closed on truncated or malformed digests", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "64 caracteres hexadecimais minúsculos", "um digest aproximado");
  expectCategory(check(root), "R024_DIGEST_FORMAT");
});

test("runner names the canonical digest delimiter and rejects sha256 equals output", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "the literal `sha256:` separator; `sha256=` is malformed output",
    "an arbitrary digest separator is accepted",
  );
  expectCategory(check(root), "R025_DIGEST_PREFIX");
});

test("runner must use the deterministic evidence serializer for recurring digest and path tuples", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "The operation payload MUST include an absolute `RUNNER_EVIDENCE_SERIALIZER` path",
    "The operation payload may omit the evidence serializer path",
  );
  expectCategory(check(root), "R030_DETERMINISTIC_EVIDENCE_SERIALIZATION");
});

test("runner must let code serialize the complete execution evidence bundle", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "--execution-bundle --operation <requested-operation>", "without the execution bundle operation");
  expectCategory(check(root), "R030_DETERMINISTIC_EVIDENCE_SERIALIZATION");
});

test("runner must let code serialize the complete canonical execution record", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "owns path-relative serialization, ordering, labels, delimiters, hashes, next check identifier, and the complete canonical", "does not own canonical execution-record serialization");
  expectCategory(check(root), "R030_DETERMINISTIC_EVIDENCE_SERIALIZATION");
});

test("runner requires a complete byte-for-byte canonical response gate", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "Before returning any result for `EXECUTE_SLICE`, `APPLY_FINDINGS`, or `VALIDATE_SLICE`, emit exactly the machine-key JSON schema for that operation",
    "Before returning a prose summary for `EXECUTE_SLICE`, `APPLY_FINDINGS`, or `VALIDATE_SLICE`, emit exactly the machine-key JSON schema for that operation",
  );
  expectCategory(check(root), "R026_OUTPUT_GATE");
});

test("runner cannot reintroduce narrative validation output beside the JSON schema", async (t) => {
  const root = await fixture(t);
  await replaceBoth(
    root,
    "# VALIDATE_SLICE\n\nSTATUS_VALIDACAO=PASS|NEEDS_FIX|BLOCKED\n",
    "# VALIDATE_SLICE\n\nSTATUS_VALIDACAO=PASS|NEEDS_FIX|BLOCKED\n\nRetorne somente `PASS`, `NEEDS_FIX` ou `BLOCKED`. Em `Findings:`, forneça uma disposição para cada finding existente.\n",
  );
  expectCategory(check(root), "R026_OUTPUT_GATE");
});

test("runner requires the exact semantic Commands tuple grammar", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "The JSON `commands` form is exact", "The JSON `commands` form is approximate");
  expectCategory(check(root), "R027_TUPLE_GRAMMAR");
});

test("runner requires the literal field sequence at the final response gate", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "The machine-key schema is fixed", "The machine-key schema may vary");
  expectCategory(check(root), "R028_FIELD_SEQUENCE");
});

test("runner requires scalar semantic fields outside Commands", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "every semantic property except `commands` is one scalar string", "every semantic property may be nested");
  expectCategory(check(root), "R029_FIELD_SHAPE");
});

const cases = [
  ["Codex model", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'model = "gpt-5.6-luna"', 'model = "gpt-5.6-sol"')],
  ["Claude tools", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "tools: Read, Glob, Grep, Bash", "tools: Read, Glob, Grep, Bash, Write")],
  ["missing adapter", "R002_REGISTRY", (root) => fs.unlink(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"))],
  ["platform divergence", "R003_EQUIVALENCE", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "Não invente comandos", "Você pode inventar comandos")],
  ["missing operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|VALIDATE_SLICE")],
  ["extra operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|CLOSE")],
  ["fourth round", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "`1/3`, `2/3` ou `3/3`", "`1/4`, `2/4`, `3/4` ou `4/4`")],
  ["check claims attempt", "R015_CHECK_AUTHORITY", (root) => replaceBoth(root, "# EXECUTE_SLICE", "# EXECUTE_SLICE\n\nCrie Validation Attempt para o check.")],
  ["runner may edit", "R005_READ_ONLY", (root) => replaceBoth(root, "Não edite código", "Edite código")],
  ["missing check status", "R006_VERDICTS", (root) => replaceBoth(root, "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED", "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|BLOCKED")],
  ["missing formal status", "R006_VERDICTS", (root) => replaceBoth(root, "STATUS_VALIDACAO=PASS|NEEDS_FIX|BLOCKED", "STATUS_VALIDACAO=PASS|BLOCKED")],
  ["schema field removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "  \"discoverySources\": \"<semantic value>\",\n", "")],
  ["discovery actions field removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "  \"discoveryActions\": \"<semantic value>\",\n", "")],
  ["correction path grammar removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "caminhos de correção são task-relative normalizados", "caminhos de correção são descritos")],
  ["finding target subset removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "subconjunto canônico dos `Finding IDs`", "uma lista livre")],
  ["unsupported finding remainder removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "contém exatamente os findings ativos do ciclo que não estão verificados; os conjuntos nunca se sobrepõem", "usa uma lista livre")],
  ["fileless correction paths removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "na correção fileless, `Correction paths` é exact `none`", "na correção fileless, caminhos arbitrários são aceitos")],
  ["PASS objective summaries allow none", "R006_VERDICTS", (root) => replaceBoth(root, "nunca podem ser exact `none`", "podem ser exact `none`")],
  ["finding disposed at origin", "R009_VALIDATION_ATTEMPT", (root) => replaceBoth(root, "Todo novo finding nasce `active` na tentativa `NEEDS_FIX` que o cria; somente uma tentativa formal estritamente posterior à origem pode resolvê-lo ou supersedê-lo.", "Todo novo finding pode nascer resolvido na tentativa que o cria.")],
  ["manifest task path base removed", "R008_MANIFEST", (root) => replaceBoth(root, "relativo ao diretório do artefato detalhado final `tasks/slice-NN.md`", "relativo a qualquer raiz")],
  ["auxiliary tested-state path base removed", "R008_MANIFEST", (root) => replaceBoth(root, "Em qualquer operação, todo caminho file-backed de `Tested state` é task-relative", "Somente em VALIDATE_SLICE, o Tested state tem um caminho relativo")],
  ["tested-state physical identity removed", "R008_MANIFEST", (root) => replaceBoth(root, "O caminho armazenado deve resolver exatamente ao target físico cujo hash foi calculado.", "O caminho armazenado pode apontar para um target semelhante.")],
  ["manifest hash weakened", "R008_MANIFEST", (root) => replaceBoth(root, "caminhos relativos únicos em ordem lexicográfica, com SHA-256 minúsculo do conteúdo ou `REMOVED`", "caminhos arbitrários com qualquer hash")],
  ["tool absence becomes non-applicable", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "check aplicável que não pode ser executado por ferramenta, credencial, dependência externa, ambiente, serviço, permissão ou comando autoritativo objetivamente indisponível é `BLOCKED`", "ferramenta ausente produz TESTS_NOT_APPLICABLE")],
  ["README loses launcher", "R012_README", (root) => replace(path.join(root, "README.md"), "slice-validate-codex.md", "validation.md")],
  ["README reintroduces legacy discovery labels", "R007_OUTPUT_SCHEMA", (root) => replace(
    path.join(root, "README.md"),
    "fontes em `Discovery sources`, métodos em `Discovery actions`",
    "fontes em `Check discovery sources`, métodos em `Check discovery actions`",
  )],
  ["Codex name", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'name = "stnl_validation_runner"', 'name = "runner"')],
  ["Codex description", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), "Runner barato e isolado", "Runner genérico")],
  ["Codex effort", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')],
  ["Codex sandbox override", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'developer_instructions = """', 'sandbox_mode = "danger-full-access"\ndeveloper_instructions = """')],
  ["Codex max depth", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), "max_depth = 1", "max_depth = 2")],
  ["Codex extra metadata", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'name = "stnl_validation_runner"', 'name = "stnl_validation_runner"\napproval_policy = "never"')],
  ["Claude name", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "name: stnl-validation-runner", "name: runner")],
  ["Claude description", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "Runner barato e isolado", "Runner genérico")],
  ["Claude model", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "model: claude-sonnet-5", "model: haiku")],
  ["Claude effort", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "effort: medium", "effort: high")],
  ["Claude extra metadata", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "effort: medium", "effort: medium\npermission: write")],
  ["missing Codex adapter", "R002_REGISTRY", (root) => fs.unlink(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"))],
  ["duplicate Claude frontmatter", "R013_SYNTAX", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "name: stnl-validation-runner", "name: stnl-validation-runner\nname: duplicate")],
  ["missing canonical ID", "R013_SYNTAX", (root) => replaceBoth(root, "CONTRATO_CANONICO=stnl-validation-runner/v8", "runner contract")],
  ["formal validation permits abbreviated command", "R020_EXACT_COMMANDS", (root) => replaceBoth(root, "não abrevie argumentos", "Você pode abreviar argumentos")],
  ["batch operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|EXECUTE_SLICES")],
  ["finalize operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|FINALIZE_SLICE")],
  ["missing round one", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "`1/3`, `2/3` ou `3/3`", "`2/3` ou `3/3`")],
  ["missing independence", "R014_INDEPENDENCE", (root) => replaceBoth(root, "Trate conclusões do contexto principal como não verificadas.", "Aceite conclusões anteriores.")],
  ["missing adapter-owned official authority preflight", "R019_REQUIREMENTS_AUTHORITY", (root) => replaceBoth(root, "objeto confiável `OFFICIAL_EXECUTION_PREFLIGHT` fornecido pelo adapter Codex configurado", "resultado arbitrário")],
  ["raw shared hash authority", "R019_REQUIREMENTS_AUTHORITY", (root) => replaceBoth(root, "Não calcule Requirements authority por SHA direto de `shared/requirements.md`", "Calcule o SHA de `shared/requirements.md` como Requirements authority")],
  ["raw feature hash authority", "R019_REQUIREMENTS_AUTHORITY", (root) => replaceBoth(root, "Não calcule Requirements authority por SHA direto de `shared/requirements.md`, por SHA direto de `feature_spec.md`", "Calcule o SHA de `feature_spec.md` como Requirements authority")],
  ["authority fallback enabled", "R019_REQUIREMENTS_AUTHORITY", (root) => replaceBoth(root, "Não use fallback ad hoc.", "Use fallback ad hoc." )],
  ["unbounded read scope", "R014_INDEPENDENCE", (root) => replaceBoth(root, "Leia somente o escopo necessário", "Leia todo o repositório")],
  ["trusts checkboxes", "R014_INDEPENDENCE", (root) => replaceBoth(root, "Não confie apenas em checkboxes ou em resultados anteriores.", "Confie nos checkboxes.")],
  ["runner may correct", "R005_READ_ONLY", (root) => replaceBoth(root, "Não aplique correções", "Aplique correções")],
  ["runner may create subagents", "R005_READ_ONLY", (root) => replaceBoth(root, "Não crie subagentes nem delegue.", "Você pode criar subagentes e delegar.")],
  ["runner may clean workspace", "R005_READ_ONLY", (root) => replaceBoth(root, "limpeza do working tree", "manutenção do working tree")],
  ["runner may revert effects", "R005_READ_ONLY", (root) => replaceBoth(root, "nunca o reverta automaticamente", "reverta automaticamente")],
  ["N/A loses objective discovery", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "executou descoberta objetiva", "fez uma suposição")],
  ["N/A loses no-command confirmation", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "confirmação de que nenhum verification command foi executado", "confirmação desconhecida")],
  ["N/A loses rationale", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "motivo objetivo", "palpite")],
  ["command failure becomes N/A", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "Falha de verification command é `TESTS_FAIL`", "Falha de verification command é `TESTS_NOT_APPLICABLE`")],
  ["missing dependency becomes N/A", "R016_NOT_APPLICABLE", (root) => replaceBoth(root, "dependência indisponível", "dependência ausente produz TESTS_NOT_APPLICABLE")],
  ["PASS loses zero exit", "R006_VERDICTS", (root) => replaceBoth(root, "`TESTS_PASS` exige que todos os comandos selecionados tenham exit code zero", "`TESTS_PASS` aceita qualquer exit code")],
  ["FAIL loses command evidence", "R006_VERDICTS", (root) => replaceBoth(root, "`TESTS_FAIL` exige comandos que falharam", "`TESTS_FAIL` não exige comandos")],
  ["BLOCKED loses objective cause", "R006_VERDICTS", (root) => replaceBoth(root, "`BLOCKED` exige impossibilidade objetiva", "`BLOCKED` aceita qualquer causa")],
  ["check claims base", "R015_CHECK_AUTHORITY", (root) => replaceBoth(root, "# APPLY_FINDINGS", "# APPLY_FINDINGS\n\nCrie Effective Validation Base para o check.")],
  ["check claims formal PASS", "R015_CHECK_AUTHORITY", (root) => replaceBoth(root, "# EXECUTE_SLICE", "# EXECUTE_SLICE\n\nEmita PASS formal.")],
  ["check claims completion", "R015_CHECK_AUTHORITY", (root) => replaceBoth(root, "# APPLY_FINDINGS", "# APPLY_FINDINGS\n\nMarque conclusão `[x]`.")],
  ["NEEDS_FIX loses structured finding", "R006_VERDICTS", (root) => replaceBoth(root, "pode criar novos findings estruturados", "pode emitir notas livres")],
  ["NEEDS_FIX creates base", "R006_VERDICTS", (root) => replaceBoth(root, "Em `NEEDS_FIX` ou `BLOCKED`, não proponha Effective Validation Base.", "Em NEEDS_FIX, crie Effective Validation Base.")],
  ["manifest allows empty", "R008_MANIFEST", (root) => replaceBoth(root, "Não retorne `PASS` com manifesto vazio", "Retorne `PASS` com manifesto vazio")],
  ["manifest allows incomplete", "R008_MANIFEST", (root) => replaceBoth(root, "vazio, incompleto, duplicado, malformado ou inconsistente", "vazio, duplicado, malformado ou inconsistente")],
  ["manifest allows duplicate", "R008_MANIFEST", (root) => replaceBoth(root, "vazio, incompleto, duplicado, malformado ou inconsistente", "vazio, incompleto, malformado ou inconsistente")],
  ["manifest allows malformed", "R008_MANIFEST", (root) => replaceBoth(root, "vazio, incompleto, duplicado, malformado ou inconsistente", "vazio, incompleto, duplicado ou inconsistente")],
  ["manifest allows inconsistency", "R008_MANIFEST", (root) => replaceBoth(root, "vazio, incompleto, duplicado, malformado ou inconsistente", "vazio, incompleto, duplicado ou malformado")],
  ["manifest loses removal", "R008_MANIFEST", (root) => replaceBoth(root, "ou `REMOVED` quando ausente", "e ignore removidos")],
  ["attempt type missing", "R009_VALIDATION_ATTEMPT", (root) => replaceBoth(root, "A primeira tentativa é `initial`; toda posterior é `revalidation`", "Toda tentativa usa um tipo livre")],
  ["finding disposition missing", "R009_VALIDATION_ATTEMPT", (root) => replaceBoth(root, "forneça uma disposição para cada finding existente", "resuma findings em geral")],
  ["PASS leaves blocker", "R009_VALIDATION_ATTEMPT", (root) => replaceBoth(root, "nenhuma disposição bloqueante ativa", "disposições bloqueantes podem ficar ativas")],
  ["overlap regressions missing", "R010_OVERLAP", (root) => replaceBoth(root, "valide o comportamento atual e regressões diretamente justificadas", "ignore comportamento e regressões")],
  ["compact output missing", "R011_COMPACT_OUTPUT", (root) => replaceBoth(root, "Responda somente de forma compacta, sem logs completos", "Responda com logs completos")],
  ["README enables fallback", "R012_README", (root) => replace(path.join(root, "README.md"), "Não existe fallback", "Fallback é permitido")],
  ["README adds manual test step", "R012_README", (root) => replace(path.join(root, "README.md"), "Não existe passo manual adicional de testes.", "Existe passo manual adicional de testes." )],
  ["README loses bounded rounds", "R012_README", (root) => replace(path.join(root, "README.md"), "no mínimo uma vez e no máximo três vezes", "quantas vezes forem necessárias")],
  ["README forwards history", "R012_README", (root) => replace(path.join(root, "README.md"), "sem histórico da conversa", "com histórico da conversa")],
  ["README transport consumes round", "R012_README", (root) => replace(path.join(root, "README.md"), "não consomem rodada `N/3`", "consomem rodada `N/3`")],
  ["README transport creates evidence", "R012_README", (root) => replace(path.join(root, "README.md"), "não criam `implementation-check-NN`, `findings-check-NN` ou `attempt-NN`", "criam registros e attempts")],
  ["README loses resume", "R012_README", (root) => replace(path.join(root, "README.md"), "retoma diretamente na delegação", "reinicia a operação")],
  ["README resets identifiers", "R012_README", (root) => replace(path.join(root, "README.md"), "não reinicia identificadores", "reinicia identificadores")],
  ["README loses third-failure state", "R012_README", (root) => replace(path.join(root, "README.md"), "terceira falha entra em `IMPLEMENTATION_RETRY_EXHAUSTED` ou `FINDINGS_RETRY_EXHAUSTED`", "terceira falha encerra sem estado")],
  ["README loses third-failure continuation", "R012_README", (root) => replace(path.join(root, "README.md"), "`VALIDATE_SLICE` é a única próxima operação", "não há próxima operação")],
  ["README loses terminal semantic review", "R017_TERMINAL_VALIDATION", (root) => replace(path.join(root, "README.md"), "cobertura global", "cobertura local")],
  ["README loses terminal deterministic integrity", "R018_TERMINAL_INTEGRITY", (root) => replace(path.join(root, "README.md"), "ownership final", "revisão genérica")],
];

for (const [name, category, mutation] of cases) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await mutation(root);
    expectCategory(check(root), category);
  });
}
