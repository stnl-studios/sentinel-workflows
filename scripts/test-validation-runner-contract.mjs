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
  assert.match(contract, /Findings verificados[\s\S]{0,160}subconjunto canônico[\s\S]{0,120}Finding IDs[\s\S]{0,180}Findings ainda não sustentados[\s\S]{0,180}exatamente os findings ativos[\s\S]{0,180}nunca se sobrepõem/u);
  assert.match(contract, /caminhos de correção[\s\S]{0,260}normalizados[\s\S]{0,160}comma-space[\s\S]{0,100}correção fileless[\s\S]{0,80}Correction paths[\s\S]{0,60}exact `none`/u);
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
  ["schema field removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "Discovery sources:\n", "")],
  ["discovery actions field removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "Discovery actions:\n", "")],
  ["correction path grammar removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "caminhos de correção são task-relative normalizados", "caminhos de correção são descritos")],
  ["finding target subset removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "subconjunto canônico dos `Finding IDs`", "uma lista livre")],
  ["unsupported finding remainder removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "contém exatamente os findings ativos do ciclo que não estão verificados; os conjuntos nunca se sobrepõem", "usa uma lista livre")],
  ["fileless correction paths removed", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "na correção fileless, `Correction paths` é exact `none`", "na correção fileless, caminhos arbitrários são aceitos")],
  ["PASS objective summaries allow none", "R006_VERDICTS", (root) => replaceBoth(root, "nunca podem ser exact `none`", "podem ser exact `none`")],
  ["finding disposed at origin", "R009_VALIDATION_ATTEMPT", (root) => replaceBoth(root, "Todo novo finding nasce `active` na tentativa `NEEDS_FIX` que o cria; somente uma tentativa formal estritamente posterior à origem pode resolvê-lo ou supersedê-lo.", "Todo novo finding pode nascer resolvido na tentativa que o cria.")],
  ["manifest task path base removed", "R008_MANIFEST", (root) => replaceBoth(root, "relativo ao diretório do artefato detalhado `tasks/slice-NN.md`", "relativo a qualquer raiz")],
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
  ["Codex sandbox", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-full-access"')],
  ["Codex max depth", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), "max_depth = 1", "max_depth = 2")],
  ["Codex extra metadata", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"), 'name = "stnl_validation_runner"', 'name = "stnl_validation_runner"\napproval_policy = "never"')],
  ["Claude name", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "name: stnl-validation-runner", "name: runner")],
  ["Claude description", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "Runner barato e isolado", "Runner genérico")],
  ["Claude model", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "model: claude-sonnet-5", "model: haiku")],
  ["Claude effort", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "effort: medium", "effort: high")],
  ["Claude extra metadata", "R001_ADAPTER_METADATA", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "effort: medium", "effort: medium\npermission: write")],
  ["missing Codex adapter", "R002_REGISTRY", (root) => fs.unlink(path.join(root, "codex/.codex/agents/stnl_validation_runner.toml"))],
  ["duplicate Claude frontmatter", "R013_SYNTAX", (root) => replace(path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md"), "name: stnl-validation-runner", "name: stnl-validation-runner\nname: duplicate")],
  ["missing canonical ID", "R013_SYNTAX", (root) => replaceBoth(root, "CONTRATO_CANONICO=stnl-validation-runner/v6", "runner contract")],
  ["batch operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|EXECUTE_SLICES")],
  ["finalize operation", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|FINALIZE_SLICE")],
  ["missing round one", "R004_OPERATION_SCOPE", (root) => replaceBoth(root, "`1/3`, `2/3` ou `3/3`", "`2/3` ou `3/3`")],
  ["missing independence", "R014_INDEPENDENCE", (root) => replaceBoth(root, "Trate conclusões do contexto principal como não verificadas.", "Aceite conclusões anteriores.")],
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
];

for (const [name, category, mutation] of cases) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await mutation(root);
    expectCategory(check(root), category);
  });
}
