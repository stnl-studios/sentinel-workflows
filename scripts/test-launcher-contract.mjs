import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const checker = path.join(repository, "scripts/check-contracts.mjs");
const canonical = path.join(repository, "templates/prompts");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-launchers-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "prompts");
  await fs.cp(canonical, root, { recursive: true });
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, "launchers", "--root", root], { encoding: "utf8" });
}

async function mutate(file, transform) {
  const before = await fs.readFile(file, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, `mutation did not change ${file}`);
  await fs.writeFile(file, after, "utf8");
}

function expectCategory(result, category) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`, "u"));
}

test("accepts the canonical registry and ignored packaging metadata", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, ".DS_Store"), "ignored\n");
  await fs.writeFile(path.join(root, "._metadata"), "ignored\n");
  assert.equal(check(root).status, 0);
});

test("accepts a harmless prose paraphrase while preserving semantics", async (t) => {
  const root = await fixture(t);
  await mutate(path.join(root, "slice-execute-codex.md"), (text) => text.replace("Não passe logs completos.", "Não encaminhe logs completos."));
  assert.equal(check(root).status, 0, check(root).stderr);
});

const cases = [
  ["removed execution close launcher", "execution-close.md", async (file) => fs.writeFile(file, "removed execution launcher\n"), "L001_REGISTRY"],
  ["obsolete launcher", "slice-finalize.md", async (file) => fs.writeFile(file, "Use `stnl-slice-executor`.\nOPERATION=FINALIZE_SLICE\n\nContexto adicional (opcional):\n"), "L001_REGISTRY"],
  ["wrong skill", "execution-plan.md", (text) => text.replace("stnl-execution-planner", "stnl-spec-execution-manager"), "L002_SKILL"],
  ["wrong operation", "execution-plan.md", (text) => text.replace("OPERATION=PLAN", "OPERATION=FINALIZE_SLICE"), "L003_OPERATION"],
  ["missing slice", "slice-execute-codex.md", (text) => text.replace(/^SLICE=.*\n/mu, ""), "L004_INPUTS"],
  ["missing replan reason", "execution-replan.md", (text) => text.replace(/^REPLAN_REASON=.*\n/mu, ""), "L004_INPUTS"],
  ["removed operation", "execution-plan.md", (text) => text.replace("Contexto adicional (opcional):", "RUN_TESTS\n\nContexto adicional (opcional):"), "L005_REMOVED_CONTRACT"],
  ["Codex identity removed", "slice-execute-codex.md", (text) => text.replace("stnl_validation_runner", "other_runner"), "L007_PLATFORM_IDENTITY"],
  ["Claude identity replaced", "slice-execute-claude.md", (text) => text.replace("@agent-stnl-validation-runner", "stnl_validation_runner"), "L007_PLATFORM_IDENTITY"],
  ["Codex inherits history", "slice-execute-codex.md", (text) => text.replace('fork_turns="none"', 'fork_turns="all"'), "L016_TRANSPORT"],
  ["forwards conversation", "slice-apply-findings-codex.md", (text) => text.replace(/não envie histórico da conversa/iu, "envie histórico da conversa"), "L012_CHECK_DELEGATION"],
  ["unbounded transport", "slice-execute-codex.md", (text) => text.replace(/no máximo uma nova tentativa técnica/iu, "tentativas técnicas ilimitadas"), "L012_CHECK_DELEGATION"],
  ["missing initialization blocker", "slice-validate-codex.md", (text) => text.replace("Runner Initialization Blocker", "transport note"), "L012_CHECK_DELEGATION"],
  ["formal authority in check", "slice-execute-codex.md", (text) => text.replace("Contexto adicional (opcional):", "Crie Validation Attempt.\n\nContexto adicional (opcional):"), "L013_CHECK_AUTHORITY"],
  ["optional runner", "slice-execute-claude.md", (text) => text.replace(/(?:Invoque|Chame).{0,50}no mínimo uma vez/iu, "Pode invocar o runner"), "L014_AUTOMATIC_RECHECK"],
  ["four-round cycle", "slice-apply-findings-claude.md", (text) => text.replace(/1\/3/g, "1/4").replace(/2\/3/g, "2/4").replace(/3\/3/g, "3/4"), "L014_AUTOMATIC_RECHECK"],
  ["validation status removed", "slice-validate-claude.md", (text) => text.replace(/PASS\s*\|\s*NEEDS_FIX\s*\|\s*BLOCKED/g, "PASS | BLOCKED"), "L008_VALIDATION_FLOW"],
  ["malformed context", "execution-tasks-review.md", (text) => `${text}\nextra\n`, "L009_CONTEXT_FORMAT"],
  ["unexpected launcher", "unexpected.md", async (file) => fs.writeFile(file, "not registered\n"), "L001_REGISTRY"],
  ["duplicate lifecycle CLOSE route", "spec-close.md", (text) => text.replace("MODE=CLOSE", "MODE=CLOSE\nOPERATION=CLOSE"), "L004_INPUTS"],
  ["extra plan input", "execution-plan.md", (text) => text.replace("SPEC_PATH={{SPEC_PATH}}", "SPEC_PATH={{SPEC_PATH}}\nSLICE={{SLICE}}"), "L004_INPUTS"],
  ["unknown placeholder", "execution-plan-review.md", (text) => text.replace("Contexto adicional (opcional):", "{{UNKNOWN}}\n\nContexto adicional (opcional):"), "L004_INPUTS"],
  ["wrong REPLAN skill", "execution-replan.md", (text) => text.replace("stnl-execution-planner", "stnl-plan-reviewer"), "L002_SKILL"],
  ["wrong REPLAN operation", "execution-replan.md", (text) => text.replace("OPERATION=REPLAN", "OPERATION=PLAN"), "L003_OPERATION"],
  ["REPLAN loses planning-only mode", "execution-replan.md", (text) => text.replace("planning-only atomic replacement", "ordinary replacement"), "L019_RECOVERY_TARGET"],
  ["shared fork syntax", "execution-plan.md", (text) => text.replace("Contexto adicional (opcional):", "fork_turns=\"none\"\n\nContexto adicional (opcional):"), "L006_SHARED_ISOLATION"],
  ["shared Claude identity", "execution-tasks.md", (text) => text.replace("Contexto adicional (opcional):", "Claude adapter\n\nContexto adicional (opcional):"), "L006_SHARED_ISOLATION"],
  ["materializer global task header removed", "execution-tasks.md", (text) => text.replace("bloco completo `# File Purpose Header`", "um bloco opcional"), "L032_TASK_INDEX_HEADER"],
  ["planner plan-claim identity guard removed", "execution-plan.md", (text) => text.replace("recompute every plan claim from its declaring artifact", "reuse every plan claim from any artifact"), "L035_PLAN_PATH_IDENTITY"],
  ["plan reviewer physical claim guard removed", "execution-plan-review.md", (text) => text.replace("recompute every reviewed plan claim from its declaring artifact", "reuse every reviewed plan claim from any artifact"), "L036_REVIEW_PLAN_PATH_IDENTITY"],
  ["shared agent identity", "execution-plan-review.md", (text) => text.replace("Contexto adicional (opcional):", "@agent-stnl-validation-runner\n\nContexto adicional (opcional):"), "L006_SHARED_ISOLATION"],
  ["Codex numeric history", "slice-validate-codex.md", (text) => text.replace('fork_turns="none"', 'fork_turns="3"'), "L016_TRANSPORT"],
  ["duplicate Codex identity", "slice-execute-codex.md", (text) => text.replace("Contexto adicional (opcional):", "stnl_validation_runner\n\nContexto adicional (opcional):"), "L007_PLATFORM_IDENTITY"],
  ["missing Codex spawn", "slice-apply-findings-codex.md", (text) => text.replace("faça spawn obrigatório", "use uma chamada"), "L007_PLATFORM_IDENTITY"],
  ["missing Claude delegation", "slice-validate-claude.md", (text) => text.replace("Delegue obrigatoriamente", "Execute"), "L007_PLATFORM_IDENTITY"],
  ["missing no-history boundary", "slice-execute-claude.md", (text) => text.replace("sem histórico da conversa", "com contexto"), "L012_CHECK_DELEGATION"],
  ["missing official authority checker payload", "slice-execute-codex.md", (text) => text.replace("o official execution validator/preflight aplicável, ", ""), "L023_REQUIREMENTS_AUTHORITY"],
  ["execute task path basis removed", "slice-execute-codex.md", (text) => text.replace("`path.relative(dirname(tasks/slice-NN.md), target)`", "um caminho relativo"), "L024_PATH_BASIS"],
  ["apply task path basis removed", "slice-apply-findings-claude.md", (text) => text.replace("`path.relative(dirname(tasks/slice-NN.md), target)`", "um caminho relativo"), "L024_PATH_BASIS"],
  ["execute canonical authority identity removed", "slice-execute-codex.md", (text) => text.replace("copie o valor byte-identical", "copie um valor recalculado"), "L026_AUTHORITY_IDENTITY"],
  ["execute delegated path identity removed", "slice-execute-codex.md", (text) => text.replace("verifique por `lstat` que os quatro paths são absolutos, canônicos, existentes e pertencem ao mesmo managed workspace", "use caminhos aproximados"), "L027_DELEGATION_PATHS"],
  ["execute invalid path repair removed", "slice-execute-claude.md", (text) => text.replace("corrija a derivação antes de invocar o runner", "ignore o caminho ausente"), "L027_DELEGATION_PATHS"],
  ["execute Tested state path basis removed", "slice-execute-codex.md", (text) => text.replace("`src/...`, `test/...`, path absoluto, CWD-relative ou repository-relative é saída malformada", "caminhos livres são permitidos"), "L028_TESTED_STATE_PATHS"],
  ["execute physical Tested state identity removed", "slice-execute-codex.md", (text) => text.replace("compare por `realpath` com o target físico que será hashado", "compare por um caminho aproximado"), "L030_PHYSICAL_PATH_IDENTITY"],
  ["execute exact digest format removed", "slice-execute-codex.md", (text) => text.replace("Antes de aceitar `TESTS_PASS` do runner", "Antes de aceitar o status do runner"), "L033_EXECUTE_DIGEST_FORMAT"],
  ["execute digest delimiter guard removed", "slice-execute-codex.md", (text) => text.replace("the literal `sha256:` delimiter; `sha256=` or any other separator is malformed output", "an arbitrary digest delimiter is accepted"), "L037_EXECUTE_DIGEST_PREFIX"],
  ["execute canonical output gate removed", "slice-execute-codex.md", (text) => text.replace("Exija do runner uma resposta exatamente no schema solicitado", "Permita que o runner resuma a resposta"), "L038_EXECUTE_OUTPUT_GATE"],
  ["execute tuple grammar guard removed", "slice-execute-codex.md", (text) => text.replace("Exija também a serialização literal", "Permita serialização livre"), "L039_EXECUTE_TUPLE_GRAMMAR"],
  ["execute literal field sequence guard removed", "slice-execute-codex.md", (text) => text.replace("Exija que a resposta do runner comece imediatamente por `Operation`", "Permita que a resposta do runner comece com prosa"), "L040_EXECUTE_FIELD_SEQUENCE"],
  ["execute scalar field shape guard removed", "slice-execute-codex.md", (text) => text.replace("Exija forma estrita dos campos", "Permita forma livre dos campos"), "L041_EXECUTE_FIELD_SHAPE"],
  ["execute raw authority disposition removed", "slice-execute-codex.md", (text) => text.replace("descarte qualquer SHA raw mencionado na resposta", "compare qualquer SHA raw mencionado na resposta"), "L034_EXECUTE_RAW_AUTHORITY_DISPOSITION"],
  ["execute raw authority comparison enabled", "slice-execute-claude.md", (text) => text.replace("Um raw digest não é authority e não pode bloquear", "Um raw digest é authority e pode bloquear"), "L029_RAW_AUTHORITY"],
  ["apply raw authority enabled", "slice-apply-findings-claude.md", (text) => text.replace("Nunca calcule hash raw", "Calcule hash raw"), "L026_AUTHORITY_IDENTITY"],
  ["validate SPEC_PATH identity removed", "slice-validate-codex.md", (text) => text.replace("copie esse valor byte-identical", "copie um path aproximado"), "L025_SPEC_PATH_IDENTITY"],
  ["validate runner starts through shell", "slice-validate-claude.md", (text) => text.replace("não tente iniciar o runner por shell", "tente iniciar o runner por shell"), "L025_SPEC_PATH_IDENTITY"],
  ["validate canonical authority identity removed", "slice-validate-codex.md", (text) => text.replace("copie o valor byte-identical", "copie um valor recalculado"), "L026_AUTHORITY_IDENTITY"],
  ["validate raw authority enabled", "slice-validate-claude.md", (text) => text.replace("Nunca calcule hash raw", "Calcule hash raw"), "L026_AUTHORITY_IDENTITY"],
  ["validate complete preflight command removed", "slice-validate-codex.md", (text) => text.replace("deve incluir o comando completo e exato", "pode resumir o comando"), "L020_EXACT_COMMANDS"],
  ["validate exact digest format removed", "slice-validate-codex.md", (text) => text.replace("64 caracteres hexadecimais minúsculos", "um digest aproximado"), "L031_DIGEST_FORMAT"],
  ["Codex loses concrete recovery target", "slice-execute-codex.md", (text) => text.replace("concrete recovery operation and slice", "generic recovery target"), "L019_RECOVERY_TARGET"],
  ["Claude infers recovery from request", "slice-validate-claude.md", (text) => text.replace("derive neither from the current request", "derive both from the current request"), "L019_RECOVERY_TARGET"],
  ["missing full-log boundary", "slice-validate-claude.md", (text) => text.replace("Não passe logs completos.", "Passe logs."), "L012_CHECK_DELEGATION"],
  ["fallback enabled", "slice-validate-codex.md", (text) => text.replace("Não faça fallback", "Faça fallback"), "L008_VALIDATION_FLOW"],
  ["manual retry enabled", "slice-execute-codex.md", (text) => text.replace("não crie etapa manual de retry", "crie retry manual"), "L008_VALIDATION_FLOW"],
  ["transport consumes round", "slice-execute-codex.md", (text) => text.replace("não consomem rodada `N/3`", "consomem rodada `N/3`"), "L016_TRANSPORT"],
  ["transport creates check", "slice-apply-findings-codex.md", (text) => text.replace("não criam `findings-check-NN`", "criam `findings-check-NN`"), "L016_TRANSPORT"],
  ["transport authorizes correction", "slice-execute-claude.md", (text) => text.replace("não autorizam correção", "autorizam correção"), "L016_TRANSPORT"],
  ["malformed output gets transport retry", "slice-validate-claude.md", (text) => text.replace("não recebe retry de transporte", "recebe retry de transporte"), "L016_TRANSPORT"],
  ["resume reimplements", "slice-execute-codex.md", (text) => text.replace("não reimplemente", "reimplemente"), "L016_TRANSPORT"],
  ["resume reapplies findings", "slice-apply-findings-claude.md", (text) => text.replace("não reaplique findings", "reaplique findings"), "L016_TRANSPORT"],
  ["transport allocates attempt", "slice-validate-codex.md", (text) => text.replace("não criam nem consomem `attempt-NN`", "criam e consomem `attempt-NN`"), "L016_TRANSPORT"],
  ["transport changes validation type", "slice-validate-claude.md", (text) => text.replace("não mudam `initial` para `revalidation`", "mudam `initial` para `revalidation`"), "L016_TRANSPORT"],
  ["validation loses N/A review", "slice-validate-codex.md", (text) => text.replace("Exija revisão independente", "Aceite sem revisão"), "L008_VALIDATION_FLOW"],
  ["validation repeats tests", "slice-validate-claude.md", (text) => text.replace("não repete testes", "repete testes"), "L013_CHECK_AUTHORITY"],
  ["N/A promoted to PASS", "slice-validate-codex.md", (text) => text.replace("Não promova não aplicabilidade a `PASS`", "promova TESTS_NOT_APPLICABLE a PASS"), "L013_CHECK_AUTHORITY"],
  ["terminal validation loses last-slice gate", "slice-validate-codex.md", (text) => text.replace("última slice aberta", "slice selecionada"), "L022_TERMINAL_VALIDATION"],
  ["terminal validation loses global coverage", "slice-validate-claude.md", (text) => text.replace("cobertura global", "revisão local"), "L022_TERMINAL_VALIDATION"],
  ["terminal authority gap loses REPLAN", "slice-validate-codex.md", (text) => text.replace("handoff para `REPLAN`", "handoff desconhecido"), "L022_TERMINAL_VALIDATION"],
  ["zero-call runner", "slice-execute-codex.md", (text) => text.replace("Contexto adicional (opcional):", "zero a três chamadas são permitidas\n\nContexto adicional (opcional):"), "L014_AUTOMATIC_RECHECK"],
  ["affirmative fourth call", "slice-apply-findings-codex.md", (text) => text.replace("Contexto adicional (opcional):", "faça uma quarta chamada\n\nContexto adicional (opcional):"), "L014_AUTOMATIC_RECHECK"],
  ["unbounded call loop", "slice-execute-claude.md", (text) => text.replace("Contexto adicional (opcional):", "use loop ilimitado\n\nContexto adicional (opcional):"), "L014_AUTOMATIC_RECHECK"],
  ["missing minimum", "slice-apply-findings-claude.md", (text) => text.replace("no mínimo uma vez e ", ""), "L014_AUTOMATIC_RECHECK"],
  ["missing round two", "slice-execute-codex.md", (text) => text.replace("`2/3`", "`round-two`"), "L014_AUTOMATIC_RECHECK"],
  ["check creates base", "slice-apply-findings-claude.md", (text) => text.replace("Contexto adicional (opcional):", "Crie Effective Validation Base.\n\nContexto adicional (opcional):"), "L013_CHECK_AUTHORITY"],
  ["check completes row", "slice-execute-codex.md", (text) => text.replace("Contexto adicional (opcional):", "Marque a conclusão `[x]`.\n\nContexto adicional (opcional):"), "L013_CHECK_AUTHORITY"],
  ["main context runs tests", "slice-execute-claude.md", (text) => text.replace("Não execute no contexto principal testes", "Execute no contexto principal testes"), "L013_CHECK_AUTHORITY"],
  ["N/A loses discovery", "slice-apply-findings-codex.md", (text) => text.replace("descoberta objetiva", "suposição"), "L013_CHECK_AUTHORITY"],
  ["N/A loses no-command proof", "slice-execute-codex.md", (text) => text.replace("nenhum comando de verificação executado", "comandos desconhecidos"), "L013_CHECK_AUTHORITY"],
  ["third failure loses continuation", "slice-execute-claude.md", (text) => text.replace("a única próxima ação da slice é `VALIDATE_SLICE`", "não há próxima ação"), "L014_AUTOMATIC_RECHECK"],
  ["automatic validation enabled", "slice-apply-findings-codex.md", (text) => text.replace("não inicie `VALIDATE_SLICE`", "inicie `VALIDATE_SLICE`"), "L013_CHECK_AUTHORITY"],
  ["invalid READINESS alias", "spec-readiness.md", (text) => text.replace("Contexto adicional (opcional):", "Use `local`.\n\nContexto adicional (opcional):"), "L015_READINESS_SCOPE"],
  ["READINESS focus optional", "spec-readiness.md", (text) => text.replace(/READINESS_FOCUS([^\n]*)(?:obrigatório|required)/iu, "READINESS_FOCUS$1opcional"), "L015_READINESS_SCOPE"],
  ["runbook locale removed", "spec-test-runbook.md", (text) => text.replaceAll("`locale`", "`language`"), "L020_RUNBOOK_OPTIONS"],
  ["runbook en-US default removed", "spec-test-runbook.md", (text) => text.replace('`locale="en-US"`', '`locale="pt-BR"`'), "L020_RUNBOOK_OPTIONS"],
  ["runbook permits locale detection", "spec-test-runbook.md", (text) => text.replace("`locale` não é detectado automaticamente", "`locale` é detectado automaticamente"), "L020_RUNBOOK_OPTIONS"],
  ["runbook pt-BR example removed", "spec-test-runbook.md", (text) => text.replace("Exemplo em português do Brasil", "Exemplo alternativo"), "L020_RUNBOOK_OPTIONS"],
  ["roadmap path removed", "spec-roadmap-init.md", (text) => text.replace(/^ROADMAP_PATH=.*\n/mu, ""), "L004_INPUTS"],
  ["roadmap authority removed", "spec-roadmap-reconcile.md", (text) => text.replaceAll("roadmap.json", "other.json"), "L021_ROADMAP_BOUNDARY"],
  ["roadmap browser state promoted", "spec-roadmap-init.md", (text) => text.replace("não é autoridade Sentinel", "é autoridade Sentinel"), "L021_ROADMAP_BOUNDARY"],
  ["roadmap mutates SPEC", "spec-roadmap-reconcile.md", (text) => text.replace("Não crie, altere nem invoque uma SPEC", "Crie uma SPEC"), "L021_ROADMAP_BOUNDARY"],
  ["removed lifecycle planning mode", "spec-resume.md", (text) => text.replace("Contexto adicional (opcional):", "MODE=PLANNING\n\nContexto adicional (opcional):"), "L005_REMOVED_CONTRACT"],
  ["removed parallelization", "execution-plan-review.md", (text) => text.replace("Contexto adicional (opcional):", "Paralelize slices.\n\nContexto adicional (opcional):"), "L005_REMOVED_CONTRACT"],
  ["removed SLICES input", "execution-plan.md", (text) => text.replace("SPEC_PATH={{SPEC_PATH}}", "SPEC_PATH={{SPEC_PATH}}\nSLICES={{SLICES}}"), "L004_INPUTS"],
  ["correction allowed after third failure", "slice-execute-codex.md", (text) => text.replace("nas rodadas 1 ou 2", "em qualquer rodada"), "L014_AUTOMATIC_RECHECK"],
  ["findings correction allowed after third failure", "slice-apply-findings-claude.md", (text) => text.replace("nas rodadas 1 ou 2", "em qualquer rodada"), "L014_AUTOMATIC_RECHECK"],
  ["third findings failure loses active findings", "slice-apply-findings-codex.md", (text) => text.replace("preserve os findings ativos", "apague os findings"), "L014_AUTOMATIC_RECHECK"],
  ["N/A resolves findings", "slice-apply-findings-claude.md", (text) => text.replace("não resolve findings por si só", "resolve findings por si só"), "L013_CHECK_AUTHORITY"],
];

for (const [name, relative, mutation, category] of cases) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    const file = path.join(root, relative);
    if (mutation.constructor.name === "AsyncFunction") await mutation(file);
    else await mutate(file, mutation);
    expectCategory(check(root), category);
  });
}
