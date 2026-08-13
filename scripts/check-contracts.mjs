#!/usr/bin/env node

import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class ContractError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

class InfrastructureError extends Error {}

function reject(category, message) {
  throw new ContractError(category, message);
}

function read(file, category = "C000_IO") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") reject(category, `missing required file: ${file}`);
    throw new InfrastructureError(`cannot read ${file}: ${error.message}`);
  }
}

function realFiles(root) {
  const output = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._") || entry.name === "__MACOSX") continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  visit(root);
  return output;
}

function parseFrontmatter(file, category = "C001_SYNTAX") {
  const text = read(file, category);
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (!match) reject(category, `invalid or missing frontmatter: ${file}`);
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/u.exec(line);
    if (!field || Object.hasOwn(metadata, field[1])) reject(category, `invalid frontmatter line in ${file}: ${line}`);
    metadata[field[1]] = field[2];
  }
  return { metadata, body: match[2].trim() };
}

function parseToml(file, category = "C001_SYNTAX") {
  const lines = read(file, category).split("\n");
  const root = {};
  let target = root;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      target = root;
      for (const part of section[1].split(".")) target = target[part] ??= {};
      continue;
    }
    const assignment = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(.*)$/u.exec(line);
    if (!assignment) reject(category, `unsupported TOML syntax in ${file}: ${lines[index]}`);
    const key = assignment[1] ?? assignment[2];
    let value = assignment[3];
    if (value.startsWith('"""')) {
      const chunks = [value.slice(3)];
      while (!chunks.at(-1).endsWith('"""')) {
        index += 1;
        if (index >= lines.length) reject(category, `unterminated TOML string: ${file}`);
        chunks.push(lines[index]);
      }
      chunks[chunks.length - 1] = chunks.at(-1).slice(0, -3);
      value = chunks.join("\n");
    } else if (/^"[\s\S]*"$/u.test(value)) {
      value = value.slice(1, -1);
    } else if (/^[0-9]+$/u.test(value)) {
      value = Number(value);
    } else {
      reject(category, `unsupported TOML value in ${file}: ${lines[index]}`);
    }
    target[key] = value;
  }
  return root;
}

function keysEqual(actual, expected) {
  const left = Object.keys(actual).sort();
  const right = Object.keys(expected).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function requirePattern(text, pattern, category, message) {
  if (!pattern.test(text)) reject(category, message);
}

function forbidPattern(text, pattern, category, message) {
  if (pattern.test(text)) reject(category, message);
}

function parseJson(file, category = "C001_SYNTAX") {
  try {
    return JSON.parse(read(file, category));
  } catch (error) {
    if (error instanceof ContractError) throw error;
    reject(category, `invalid JSON in ${file}: ${error.message}`);
  }
}

function checkFilePurposeHeader(file, owner) {
  const text = read(file);
  const match = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n/u.exec(text);
  if (!match) reject("C008_FILE_HEADERS", `missing File Purpose Header: ${file}`);
  const lines = match[1].split("\n").filter(Boolean);
  const fields = lines.map((line) => line.split(":", 1)[0]);
  const expected = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"];
  if (JSON.stringify(fields) !== JSON.stringify(expected)) reject("C008_FILE_HEADERS", `noncanonical File Purpose Header fields: ${file}`);
  const values = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  if (!["draft", "ready", "blocked", "done", "closed", "not_applicable"].includes(values.status)) reject("C008_FILE_HEADERS", `invalid File Purpose Header status: ${file}`);
  const expectedOwner = path.basename(file) === "execution-record-schema.md" ? "stnl-task-materializer" : owner;
  if (values.owner !== expectedOwner) reject("C008_FILE_HEADERS", `wrong File Purpose Header owner: ${file}`);
  if ((text.match(/```yaml/gu) ?? []).length !== 1) reject("C008_FILE_HEADERS", `extra YAML block in execution resource: ${file}`);
}

const checkSchemas = {
  EXECUTE_SLICE: [
    "Operação: EXECUTE_SLICE",
    "Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",
    "Automatic check round:",
    "HEAD:",
    "Escopo verificado:",
    "Estado testado:",
    "Check discovery sources:",
    "Check discovery actions:",
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
  APPLY_FINDINGS: [
    "Operação: APPLY_FINDINGS",
    "Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",
    "Automatic check round:",
    "Ciclo de findings:",
    "HEAD:",
    "Escopo verificado:",
    "Estado testado:",
    "Check discovery sources:",
    "Check discovery actions:",
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
  VALIDATE_SLICE: [
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
  ],
};

function extractSchema(contract, operation) {
  const match = new RegExp(`## Schema ${operation}\\n\\n\\x60\\x60\\x60text\\n([\\s\\S]*?)\\x60\\x60\\x60`, "u").exec(contract);
  if (!match) reject("R007_OUTPUT_SCHEMA", `runner output schema is missing: ${operation}`);
  return match[1].split("\n").filter(Boolean);
}

function checkRunner(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new InfrastructureError(`not a directory: ${root}`);
  const codexFile = path.join(root, "codex/.codex/agents/stnl_validation_runner.toml");
  const claudeFile = path.join(root, "claude-code/.claude/agents/stnl-validation-runner.md");
  const readmeFile = path.join(root, "README.md");
  for (const file of [codexFile, claudeFile, readmeFile]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) reject("R002_REGISTRY", `missing runner file: ${file}`);
  }
  const codex = parseToml(codexFile, "R013_SYNTAX");
  const claude = parseFrontmatter(claudeFile, "R013_SYNTAX");
  const expectedCodex = {
    name: "stnl_validation_runner",
    description: "Runner barato e isolado para checks de implementação, checks de findings e validação formal independente de uma slice.",
    model: "gpt-5.4-mini",
    model_reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
    developer_instructions: codex.developer_instructions,
    agents: { max_depth: 1 },
  };
  if (!keysEqual(codex, expectedCodex) || Object.entries(expectedCodex).some(([key, value]) => key !== "developer_instructions" && key !== "agents" && codex[key] !== value) || codex.agents?.max_depth !== 1) {
    reject("R001_ADAPTER_METADATA", "Codex runner adapter metadata changed");
  }
  const expectedClaude = {
    name: "stnl-validation-runner",
    description: expectedCodex.description,
    tools: "Read, Glob, Grep, Bash",
    model: "haiku",
    effort: "medium",
  };
  if (!keysEqual(claude.metadata, expectedClaude) || Object.entries(expectedClaude).some(([key, value]) => claude.metadata[key] !== value)) {
    reject("R001_ADAPTER_METADATA", "Claude runner adapter metadata changed");
  }
  const contract = String(codex.developer_instructions ?? "").trim();
  if (contract !== claude.body) reject("R003_EQUIVALENCE", "runner platform contracts diverge");

  requirePattern(contract, /^CONTRATO_CANONICO=stnl-validation-runner\/v[0-9]+$/mu, "R013_SYNTAX", "canonical runner contract ID is missing");
  const operations = /^OPERACOES_SUPORTADAS=([^\n]+)$/mu.exec(contract)?.[1];
  if (operations !== "EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE") reject("R004_OPERATION_SCOPE", `invalid runner operations: ${operations ?? "missing"}`);
  if (!contract.includes("STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED") || !contract.includes("STATUS_VALIDACAO=PASS|NEEDS_FIX|BLOCKED")) {
    reject("R006_VERDICTS", "runner statuses differ from the canonical protocol sets");
  }
  for (const [operation, expected] of Object.entries(checkSchemas)) {
    const actual = extractSchema(contract, operation);
    if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) reject("R007_OUTPUT_SCHEMA", `${operation} output schema changed`);
  }
  for (const heading of ["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]) {
    requirePattern(contract, new RegExp(`^# ${heading}$`, "mu"), "R004_OPERATION_SCOPE", `missing runner section: ${heading}`);
  }
  forbidPattern(contract, /^# (?:CLOSE|REPLAN|FINALIZE_SLICE|PARALLELIZE_SLICES|RUN_TESTS)$/mu, "R004_OPERATION_SCOPE", "runner contains a forbidden operation");
  requirePattern(contract, /1\/3[\s\S]{0,80}2\/3[\s\S]{0,80}3\/3/u, "R004_OPERATION_SCOPE", "runner lacks the exact three-round input set");
  forbidPattern(contract, /(?:1\/4|2\/4|3\/4|4\/4)/u, "R004_OPERATION_SCOPE", "runner permits a fourth automatic round");
  requirePattern(contract, /conclusões do contexto principal como não verificadas/iu, "R014_INDEPENDENCE", "runner does not independently verify main-context claims");
  requirePattern(contract, /Leia somente o escopo necessário/iu, "R014_INDEPENDENCE", "runner read scope is not bounded");
  requirePattern(contract, /Não confie apenas em checkboxes ou em resultados anteriores/iu, "R014_INDEPENDENCE", "runner can trust historical claims without verification");

  const execute = /# EXECUTE_SLICE\n([\s\S]*?)# APPLY_FINDINGS\n/u.exec(contract)?.[1] ?? "";
  const findings = /# APPLY_FINDINGS\n([\s\S]*?)# VALIDATE_SLICE\n/u.exec(contract)?.[1] ?? "";
  for (const [operation, section] of [["EXECUTE_SLICE", execute], ["APPLY_FINDINGS", findings]]) {
    forbidPattern(section, /(?:crie|create|emita|emit|marque|mark).{0,80}(?:Validation Attempt|Effective Validation Base|PASS formal|conclusão `\[x\]`)/iu, "R015_CHECK_AUTHORITY", `${operation} claims formal authority`);
  }
  forbidPattern(contract, /(?:^|\n)(?:Edite|Edit|Aplique correções|Apply corrections|Crie subagentes|Create subagents)/iu, "R005_READ_ONLY", "runner permits mutation or delegation");
  requirePattern(contract, /Não (?:edite|implemente)[\s\S]{0,250}(?:código|code)/iu, "R005_READ_ONLY", "runner read-only boundary is missing");
  requirePattern(contract, /Não aplique correções[\s\S]{0,300}(?:lockfiles|commits|deploys|migrações|working tree)/iu, "R005_READ_ONLY", "runner mutation and cleanup prohibitions are incomplete");
  requirePattern(contract, /limpeza do working tree/iu, "R005_READ_ONLY", "runner working-tree cleanup prohibition is missing");
  requirePattern(contract, /Não crie subagentes nem delegue|Do not create subagents or delegate/iu, "R005_READ_ONLY", "runner no-delegation boundary is missing");
  forbidPattern(contract, /(?:você pode|você deve|é permitido|you may|you must|you can)[^\n]{0,80}(?:editar|edit|implementar|implement|aplicar correções|apply corrections|criar subagentes|create subagents|delegar|delegate)/iu, "R005_READ_ONLY", "runner includes affirmative mutation or delegation authority");
  requirePattern(contract, /TESTS_NOT_APPLICABLE[\s\S]{0,700}(?:descoberta objetiva|objective discovery)/iu, "R016_NOT_APPLICABLE", "non-applicability lacks objective discovery");
  requirePattern(contract, /TESTS_NOT_APPLICABLE[\s\S]{0,1200}(?:nenhum verification command|no verification command)/iu, "R016_NOT_APPLICABLE", "non-applicability permits verification commands");
  requirePattern(contract, /confirmação de que nenhum verification command foi executado/iu, "R016_NOT_APPLICABLE", "non-applicability lacks no-command confirmation");
  requirePattern(contract, /TESTS_NOT_APPLICABLE[\s\S]{0,900}(?:motivo objetivo|objective rationale)/iu, "R016_NOT_APPLICABLE", "non-applicability lacks an objective rationale");
  forbidPattern(contract, /(?:ferramenta ausente|missing tool).{0,120}TESTS_NOT_APPLICABLE|verification command.{0,100}(?:falh|fail).{0,100}TESTS_NOT_APPLICABLE/iu, "R016_NOT_APPLICABLE", "runner masks a blocker or failure as non-applicability");
  requirePattern(contract, /ferramenta ausente[\s\S]{0,500}(?:BLOCKED|TESTS_FAIL)/iu, "R016_NOT_APPLICABLE", "missing tools are not separated from non-applicability");
  forbidPattern(contract, /TESTS_NOT_APPLICABLE[^\n]{0,180}(?:comandos executados|verification commands executed)[^\n]{0,60}(?!nenhum|none)/iu, "R016_NOT_APPLICABLE", "non-applicability can include a verification command");
  requirePattern(contract, /NEEDS_FIX[\s\S]{0,700}(?:finding estruturado|structured finding)/iu, "R006_VERDICTS", "NEEDS_FIX lacks structured findings");
  requirePattern(contract, /NEEDS_FIX[^\n]{0,300}pode criar novos findings estruturados/iu, "R006_VERDICTS", "NEEDS_FIX cannot persist structured findings");
  requirePattern(contract, /`TESTS_PASS` exige[^\n]{0,160}exit code zero/iu, "R006_VERDICTS", "TESTS_PASS lacks zero-exit authority");
  requirePattern(contract, /`TESTS_FAIL` exige[^\n]{0,160}(?:comandos que falharam|commands that failed)/iu, "R006_VERDICTS", "TESTS_FAIL lacks command-failure evidence");
  requirePattern(contract, /`BLOCKED` exige[^\n]{0,180}(?:impossibilidade objetiva|objective impossibility)/iu, "R006_VERDICTS", "BLOCKED lacks an objective cause");
  forbidPattern(contract, /(?:NEEDS_FIX|BLOCKED)[\s\S]{0,160}(?:(?<!não )proponha|create|(?<!não )crie) Effective Validation Base/iu, "R006_VERDICTS", "non-PASS verdict creates an effective base");
  requirePattern(contract, /caminhos relativos únicos[\s\S]{0,180}SHA-256[\s\S]{0,100}`REMOVED`/iu, "R008_MANIFEST", "final manifest path/hash/removal semantics are incomplete");
  requirePattern(contract, /Estado testado[\s\S]{0,180}Manifesto final da slice[\s\S]{0,220}relativo ao diretório do artefato detalhado `tasks\/slice-NN\.md`/iu, "R008_MANIFEST", "tested-state and manifest path base is ambiguous");
  requirePattern(contract, /fontes consultadas em `Check discovery sources`[\s\S]{0,160}`Check discovery actions`/iu, "R007_OUTPUT_SCHEMA", "discovery sources and actions are not distinct");
  requirePattern(contract, /não retorne `PASS` com manifesto vazio, incompleto, duplicado, malformado ou inconsistente/iu, "R008_MANIFEST", "manifest rejection cases are incomplete");
  requirePattern(contract, /overlap[\s\S]{0,500}regressões[\s\S]{0,300}(?:NEEDS_FIX|BLOCKED)/iu, "R010_OVERLAP", "overlap and regression obligations are incomplete");
  requirePattern(contract, /Para cada overlap[^\n]{0,100}valide o comportamento atual e regressões/iu, "R010_OVERLAP", "overlap behavior/regression validation is missing");
  requirePattern(contract, /primeira tentativa[^\n]{0,40}`initial`[^\n]{0,80}`revalidation`/iu, "R009_VALIDATION_ATTEMPT", "attempt type progression is missing");
  requirePattern(contract, /PASS[^\n]{0,240}manifesto final completo/iu, "R009_VALIDATION_ATTEMPT", "PASS does not require a complete final manifest");
  requirePattern(contract, /Findings:[^\n]{0,180}(?:disposição para cada finding|disposition for every finding)/iu, "R009_VALIDATION_ATTEMPT", "formal validation lacks per-finding disposition");
  requirePattern(contract, /PASS[^\n]{0,260}nenhuma disposição bloqueante ativa/iu, "R009_VALIDATION_ATTEMPT", "PASS may leave a blocking finding active");
  requirePattern(contract, /Checks nunca emitem[^\n]{0,160}(?:Validation Attempt|Effective Validation Base)/iu, "R015_CHECK_AUTHORITY", "check/formal authority separation is incomplete");
  requirePattern(contract, /Responda somente de forma compacta[^\n]{0,120}sem logs completos/iu, "R011_COMPACT_OUTPUT", "runner compact-output boundary is missing");
  requirePattern(contract, /nunca o reverta automaticamente/iu, "R005_READ_ONLY", "runner may automatically revert workspace effects");

  const readme = read(readmeFile, "R002_REGISTRY");
  for (const launcher of ["slice-execute-codex.md", "slice-execute-claude.md", "slice-apply-findings-codex.md", "slice-apply-findings-claude.md", "slice-validate-codex.md", "slice-validate-claude.md"]) {
    if (!readme.includes(launcher)) reject("R012_README", `runner README omits launcher: ${launcher}`);
  }
  forbidPattern(readme, /(?:CLOSE).{0,100}(?:(?<!não )usa|(?<!não )invoca).{0,80}(?:runner|test)/iu, "R012_README", "README makes CLOSE invoke validation");
  requirePattern(readme, /não existe fallback/iu, "R012_README", "README fallback boundary is missing");
  requirePattern(readme, /não existe passo manual adicional de testes/iu, "R012_README", "README manual-test-step boundary is missing");
  requirePattern(readme, /no mínimo uma vez e no máximo três vezes/iu, "R012_README", "README bounded automatic-round policy is missing");
  requirePattern(readme, /sem histórico da conversa[\s\S]{0,500}Históricos e logs completos não são encaminhados/iu, "R012_README", "README history/minimum-payload boundary is missing");
  requirePattern(readme, /Falha de inicialização ou transporte[\s\S]{0,300}não consomem rodada `N\/3`/iu, "R012_README", "README transport/round separation is missing");
  requirePattern(readme, /não criam `implementation-check-NN`, `findings-check-NN` ou `attempt-NN`/iu, "R012_README", "README transport/evidence separation is missing");
  requirePattern(readme, /retoma diretamente na delegação[\s\S]{0,240}não reinicia identificadores/iu, "R012_README", "README initialization-resume semantics are missing");
  requirePattern(readme, /terceira falha entra em `IMPLEMENTATION_RETRY_EXHAUSTED` ou `FINDINGS_RETRY_EXHAUSTED`[\s\S]{0,180}`VALIDATE_SLICE` é a única próxima operação/iu, "R012_README", "README third-failure recovery is missing");
}

function checkScout(root) {
  const codexFile = path.join(root, "codex/.codex/agents/stnl_spec_context_scout.toml");
  const claudeFile = path.join(root, "claude-code/.claude/agents/stnl-spec-context-scout.md");
  const codex = parseToml(codexFile, "S007_SYNTAX");
  const claude = parseFrontmatter(claudeFile, "S007_SYNTAX");
  const description = "Read-only exception scout for one explicitly authorized lifecycle evidence gap; never auto-select or delegate.";
  const expectedCodex = {
    name: "stnl_spec_context_scout", description, model: "gpt-5.4-mini", model_reasoning_effort: "medium",
    sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled",
    developer_instructions: codex.developer_instructions, agents: { max_depth: 1 },
  };
  const expectedClaude = { name: "stnl-spec-context-scout", description, tools: "Read, Glob, Grep", model: "haiku", effort: "medium" };
  if (!keysEqual(codex, expectedCodex) || Object.entries(expectedCodex).some(([key, value]) => !["developer_instructions", "agents"].includes(key) && codex[key] !== value) || codex.agents?.max_depth !== 1) reject("S001_ADAPTER_METADATA", "Codex scout metadata changed");
  if (!keysEqual(claude.metadata, expectedClaude) || Object.entries(expectedClaude).some(([key, value]) => claude.metadata[key] !== value)) reject("S001_ADAPTER_METADATA", "Claude scout metadata changed");
  const contract = String(codex.developer_instructions ?? "").trim();
  if (contract !== claude.body) reject("S003_EQUIVALENCE", "scout platform contracts diverge");
  requirePattern(contract, /^CONTRACT_ID=stnl-spec-context-scout\/v[0-9]+$/mu, "S007_SYNTAX", "scout contract ID is missing");
  requirePattern(contract, /SCOUT_CALL=1\/1/u, "S004_BOUNDARIES", "scout bounded-call token is missing");
  requirePattern(contract, /Do not (?:write|edit|create|delete)[\s\S]{0,600}Do not (?:invoke Agent|spawn a subagent|delegate)/u, "S004_BOUNDARIES", "scout read-only or no-delegation boundary is missing");
  const schema = /```text\n([\s\S]*?)```/u.exec(contract)?.[1].split("\n").filter(Boolean) ?? [];
  const expected = ["Scope anchors:", "Current behavior:", "Existing authorities:", "Relevant tests:", "Observed constraints:", "Conflicts:", "Gaps:", "Exact references:", "Confidence:"];
  if (schema.length !== expected.length || schema.some((line, index) => line !== expected[index])) reject("S005_OUTPUT", "scout schema changed");
}

function checkSubagents(root) {
  const expected = new Set([
    "README.md",
    "codex/.codex/agents/stnl_validation_runner.toml",
    "codex/.codex/agents/stnl_spec_context_scout.toml",
    "claude-code/.claude/agents/stnl-validation-runner.md",
    "claude-code/.claude/agents/stnl-spec-context-scout.md",
  ]);
  const actual = new Set(realFiles(root).map((file) => path.relative(root, file).split(path.sep).join("/")));
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) reject("S002_REGISTRY", `subagent registry mismatch; actual=${JSON.stringify([...actual].sort())}`);
  checkRunner(root);
  checkScout(root);
}

const launcherSpecs = {
  "spec-init": ["stnl-spec-lifecycle-manager", "MODE", "INIT", [["SPEC_PATH", "{{SPEC_PATH}}"], ["REQUIREMENTS_SOURCE", "{{REQUIREMENTS_SOURCE}}"]]],
  "spec-resume": ["stnl-spec-lifecycle-manager", "MODE", "RESUME", [["SPEC_PATH", "{{SPEC_PATH}}"], ["NEW_INFORMATION", "{{NEW_INFORMATION}}"]]],
  "spec-readiness": ["stnl-spec-lifecycle-manager", "MODE", "READINESS", [["SPEC_PATH", "{{SPEC_PATH}}"], ["READINESS_SCOPE", "{{READINESS_SCOPE}}"], ["READINESS_FOCUS", "{{READINESS_FOCUS}}"]]],
  "spec-close": ["stnl-spec-lifecycle-manager", "MODE", "CLOSE", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "spec-test-runbook": ["stnl-spec-test-runbook", "OPERATION", "GENERATE_RUNBOOK", [["SPEC_PATH", "{{SPEC_PATH}}"], ["RUNBOOK_SCOPE", "{{RUNBOOK_SCOPE}}"], ["RUNBOOK_SELECTION", "{{RUNBOOK_SELECTION}}"], ["RUNBOOK_OPTIONS", "{{RUNBOOK_OPTIONS}}"]]],
  "execution-plan": ["stnl-execution-planner", "OPERATION", "PLAN", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "execution-replan": ["stnl-execution-planner", "OPERATION", "REPLAN", [["SPEC_PATH", "{{SPEC_PATH}}"], ["REPLAN_REASON", "{{REPLAN_REASON}}"]]],
  "execution-plan-review": ["stnl-plan-reviewer", "OPERATION", "REVIEW_PLAN", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "execution-tasks": ["stnl-task-materializer", "OPERATION", "MATERIALIZE_TASKS", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "execution-tasks-review": ["stnl-task-reviewer", "OPERATION", "REVIEW_TASKS", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "execution-close": ["stnl-execution-closer", "OPERATION", "CLOSE", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "slice-execute-codex": ["stnl-slice-executor", "OPERATION", "EXECUTE_SLICE", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
  "slice-execute-claude": ["stnl-slice-executor", "OPERATION", "EXECUTE_SLICE", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
  "slice-apply-findings-codex": ["stnl-slice-executor", "OPERATION", "APPLY_FINDINGS", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
  "slice-apply-findings-claude": ["stnl-slice-executor", "OPERATION", "APPLY_FINDINGS", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
  "slice-validate-codex": ["stnl-slice-quality-manager", "OPERATION", "VALIDATE_SLICE", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
  "slice-validate-claude": ["stnl-slice-quality-manager", "OPERATION", "VALIDATE_SLICE", [["SPEC_PATH", "{{SPEC_PATH}}"], ["SLICE", "{{SLICE}}"]]],
};

const runnerLaunchers = new Set(Object.keys(launcherSpecs).filter((name) => name.startsWith("slice-")));
const sharedExecution = new Set(["execution-plan", "execution-replan", "execution-plan-review", "execution-tasks", "execution-tasks-review", "execution-close"]);

function parseLauncher(file, spec) {
  const text = read(file, "L001_REGISTRY");
  const lines = text.split(/\r?\n/u);
  const context = lines.lastIndexOf("Contexto adicional (opcional):");
  if (context < 0 || lines.slice(context + 1).some((line) => line !== "")) reject("L009_CONTEXT_FORMAT", `${file}: optional context must be the final heading`);
  const body = lines.slice(0, context);
  while (body.at(-1) === "") body.pop();
  if (body[0] !== `Use \`${spec[0]}\`.`) reject("L002_SKILL", `${file}: wrong skill`);
  if (body[1] !== `${spec[1]}=${spec[2]}`) reject("L003_OPERATION", `${file}: wrong operation`);
  const assignments = [];
  let index = 2;
  while (/^[A-Z_]+=/u.test(body[index] ?? "")) {
    const split = body[index].indexOf("=");
    assignments.push([body[index].slice(0, split), body[index].slice(split + 1)]);
    index += 1;
  }
  if (JSON.stringify(assignments) !== JSON.stringify(spec[3])) reject("L004_INPUTS", `${file}: expected ${JSON.stringify(spec[3])}, got ${JSON.stringify(assignments)}`);
  const placeholders = [...text.matchAll(/\{\{([^{}]+)\}\}/gu)].map((match) => match[1]).sort();
  const expected = spec[3].map(([key]) => key).sort();
  if (JSON.stringify(placeholders) !== JSON.stringify(expected)) reject("L004_INPUTS", `${file}: placeholder set changed`);
  return { text, instructions: body.slice(index).join("\n") };
}

function checkLaunchers(root) {
  const actual = Object.fromEntries(fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== ".DS_Store" && !entry.name.startsWith("._"))
    .map((entry) => [entry.name.slice(0, -3), path.join(root, entry.name)]));
  if (!keysEqual(actual, launcherSpecs)) reject("L001_REGISTRY", `launcher registry mismatch; actual=${JSON.stringify(Object.keys(actual).sort())}`);
  for (const [name, spec] of Object.entries(launcherSpecs)) {
    const { text, instructions } = parseLauncher(actual[name], spec);
    forbidPattern(text, /(?:FINALIZE_SLICE|PARALLELIZE_SLICES|RUN_TESTS|RETRY_TESTS|FIX_TESTS|EXECUTE_SLICES|MODE=PLANNING|^SLICES=|paraleliz)/imu, "L005_REMOVED_CONTRACT", `${name}: removed operation remains`);
    if (sharedExecution.has(name)) {
      forbidPattern(text, /(?:stnl[_-]validation[_-]runner|@agent-|\bCodex\b|\bClaude\b|fork_turns|\bspawn\b|\bdeleg)/iu, "L006_SHARED_ISOLATION", `${name}: shared launcher contains platform invocation syntax`);
    }
    if (name === "execution-close") forbidPattern(instructions, /(?:runner|spawn|deleg|testes?|builds?|linters?|typechecks?|compila|retry|correç)/iu, "L006_SHARED_ISOLATION", "execution CLOSE invokes validation or repair");
    if (name === "execution-replan") {
      requirePattern(text, /OPERATION=REPLAN/u, "L003_OPERATION", "REPLAN launcher operation is missing");
      requirePattern(text, /REPLAN_REASON=\{\{REPLAN_REASON\}\}/u, "L004_INPUTS", "REPLAN_REASON is missing");
    }
    if (name === "spec-readiness") {
      requirePattern(instructions, /(?:only|somente).{0,40}`LOCAL`.{0,30}`GLOBAL`|`LOCAL`.{0,30}`GLOBAL`.{0,80}(?:case-sensitive|sem aliases)/iu, "L015_READINESS_SCOPE", "READINESS exact scope set is missing");
      requirePattern(instructions, /READINESS_FOCUS.{0,100}(?:obrigat|required)/iu, "L015_READINESS_SCOPE", "LOCAL focus requirement is missing");
      forbidPattern(instructions, /`(?:local|global|localized|repository)`/u, "L015_READINESS_SCOPE", "READINESS scope alias is present");
    }
    if (!runnerLaunchers.has(name)) continue;
    const isCodex = name.endsWith("-codex");
    if (isCodex) {
      if ((text.match(/stnl_validation_runner/gu) ?? []).length !== 1 || text.includes("@agent-") || /\bClaude\b/u.test(text)) reject("L007_PLATFORM_IDENTITY", `${name}: invalid Codex identity`);
      requirePattern(instructions, /(?:faça|make|must).{0,40}spawn|spawn.{0,50}(?:obrigat|must)/iu, "L007_PLATFORM_IDENTITY", `${name}: mandatory Codex spawn is missing`);
      requirePattern(instructions, /fork_turns="none"/u, "L016_TRANSPORT", `${name}: Codex must start without inherited turns`);
      forbidPattern(instructions, /fork_turns="(?:all|[1-9][0-9]*)"/u, "L016_TRANSPORT", `${name}: full/history fork is forbidden`);
    } else {
      if ((text.match(/^@agent-stnl-validation-runner$/gmu) ?? []).length !== 1 || text.includes("stnl_validation_runner") || /\bCodex\b/u.test(text)) reject("L007_PLATFORM_IDENTITY", `${name}: invalid Claude identity`);
      requirePattern(instructions, /deleg.{0,40}(?:obrigat|must)|(?:obrigat|must).{0,40}deleg/iu, "L007_PLATFORM_IDENTITY", `${name}: mandatory Claude delegation is missing`);
    }
    requirePattern(instructions, /(?:sem histórico|não envie histórico|without inherited|no conversation history)/iu, "L012_CHECK_DELEGATION", `${name}: conversation history boundary is missing`);
    forbidPattern(instructions, /(?:(?<!não )envie|(?<!do not )forward|(?<!do not )include).{0,30}(?:histórico da conversa|conversation history)/iu, "L012_CHECK_DELEGATION", `${name}: forwards conversation history`);
    requirePattern(instructions, /(?:no máximo uma nova tentativa|at most one (?:new )?(?:transport )?retry|retry.{0,40}once)/iu, "L012_CHECK_DELEGATION", `${name}: transport retry must be bounded to one`);
    requirePattern(instructions, /Runner Initialization Blocker/u, "L012_CHECK_DELEGATION", `${name}: missing singleton initialization blocker`);
    forbidPattern(instructions, /(?:(?<!não )faça|(?<!do not )use|(?<!do not )perform).{0,30}fallback|fallback.{0,30}(?:permit|allowed)/iu, "L008_VALIDATION_FLOW", `${name}: fallback is enabled`);
    requirePattern(instructions, /não (?:passe|envie|encaminhe)[^\n]{0,60}logs completos|do not (?:send|forward)[^\n]{0,60}full logs/iu, "L012_CHECK_DELEGATION", `${name}: minimum-payload boundary omits the full-log prohibition`);
    requirePattern(instructions, /tentativas[^\n]{0,80}não consomem rodada|transport[^\n]{0,80}(?:does not|do not) consume[^\n]{0,30}round/iu, "L016_TRANSPORT", `${name}: transport failures can consume a semantic round`);
    requirePattern(instructions, /saída malformada[^\n]{0,100}não recebe retry de transporte|malformed[^\n]{0,100}no transport retry/iu, "L016_TRANSPORT", `${name}: malformed output is confused with transport initialization`);
    requirePattern(instructions, /retome diretamente (?:no spawn|na delegação)|resume directly (?:at|with) (?:spawn|delegation)/iu, "L016_TRANSPORT", `${name}: initialization-blocker resume path is missing`);
    forbidPattern(instructions, /(?<!não )(?:faça|crie|execute|use)[^\n]{0,40}(?:fallback|retry manual)|(?:fallback|manual retry)[^\n]{0,40}(?:permitid|allowed)/iu, "L008_VALIDATION_FLOW", `${name}: fallback or manual retry is enabled`);
    if (spec[2] === "VALIDATE_SLICE") {
      requirePattern(instructions, /PASS\s*\|\s*NEEDS_FIX\s*\|\s*BLOCKED/u, "L008_VALIDATION_FLOW", `${name}: formal status set changed`);
      requirePattern(instructions, /Effective Validation Base[\s\S]{0,100}(?:finaliza|complete)/iu, "L008_VALIDATION_FLOW", `${name}: PASS does not atomically finalize`);
      requirePattern(instructions, /(?:Exija|Require)[^\n]{0,40}(?:revisão|review) independente[^\n]{0,100}TESTS_NOT_APPLICABLE/iu, "L008_VALIDATION_FLOW", `${name}: non-applicability is not independently reviewed`);
      forbidPattern(instructions, /(?<!não )(?:promova|converta|trate)[^\n]{0,80}TESTS_NOT_APPLICABLE[^\n]{0,80}(?:PASS|aprova)/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability is promoted to PASS`);
      requirePattern(instructions, /não (?:repete|executa)[^\n]{0,80}testes|does not (?:repeat|run)[^\n]{0,80}tests/iu, "L013_CHECK_AUTHORITY", `${name}: main context may repeat formal checks`);
      requirePattern(instructions, /não criam? nem consomem? `attempt-NN`|does not (?:create|consume)[^\n]{0,30}attempt/iu, "L016_TRANSPORT", `${name}: transport failure may allocate a formal attempt`);
      requirePattern(instructions, /não mudam? `initial` para `revalidation`|does not change[^\n]{0,30}initial[^\n]{0,30}revalidation/iu, "L016_TRANSPORT", `${name}: transport failure may change validation type`);
    } else {
      requirePattern(instructions, /TESTS_PASS[\s\S]{0,80}TESTS_FAIL[\s\S]{0,80}TESTS_NOT_APPLICABLE[\s\S]{0,80}BLOCKED/u, "L014_AUTOMATIC_RECHECK", `${name}: auxiliary status set changed`);
      requirePattern(instructions, /(?:no mínimo uma vez|at least once)[\s\S]{0,80}(?:no máximo três vezes|at most three times)/iu, "L014_AUTOMATIC_RECHECK", `${name}: one-to-three runner budget is missing`);
      requirePattern(instructions, /1\/3[\s\S]{0,40}2\/3[\s\S]{0,40}3\/3/u, "L014_AUTOMATIC_RECHECK", `${name}: exact round set is missing`);
      forbidPattern(instructions, /(?<!nunca )faça uma quarta chamada|(?<!never )make a fourth call|(?<!nem )(?<!não )use loop ilimitado|(?<!never )use an unbounded loop/iu, "L014_AUTOMATIC_RECHECK", `${name}: retry cycle is unbounded`);
      forbidPattern(instructions, /(?:zero a três|zero to three|runner invocation is optional|Pode invocar o runner|(?<!Não )Pule o runner)/iu, "L014_AUTOMATIC_RECHECK", `${name}: runner invocation became optional`);
      forbidPattern(instructions, /(?<!não )(?:Emita `PASS` formal|Crie Validation Attempt|Crie Effective Validation Base|Marque a conclusão `\[x\]`)/iu, "L013_CHECK_AUTHORITY", `${name}: auxiliary check claims formal authority`);
      requirePattern(instructions, /Não execute no contexto principal[^\n]{0,120}(?:testes|builds|linters|typechecks|compila)|Do not run[^\n]{0,120}(?:tests|builds|linters|typechecks)[^\n]{0,40}main context/iu, "L013_CHECK_AUTHORITY", `${name}: main-context verification prohibition is missing`);
      requirePattern(instructions, /TESTS_NOT_APPLICABLE[^\n]{0,240}(?:descoberta objetiva|objective discovery)[\s\S]{0,220}(?:nenhum comando de verificação|no verification command)/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability evidence is incomplete`);
      forbidPattern(instructions, /(?<!não )(?:promova|trate|converta)[^\n]{0,80}TESTS_NOT_APPLICABLE[^\n]{0,80}(?:PASS|aprova)/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability is promoted to PASS`);
      requirePattern(instructions, /não criam `(?:implementation|findings)-check-NN`|does not create[^\n]{0,40}(?:implementation|findings)-check/iu, "L016_TRANSPORT", `${name}: transport failure may allocate check evidence`);
      requirePattern(instructions, /não autorizam correção|does not authorize correction/iu, "L016_TRANSPORT", `${name}: transport failure may authorize correction`);
      requirePattern(instructions, /não (?:reimplemente|reaplique findings)|do not (?:reimplement|reapply findings)/iu, "L016_TRANSPORT", `${name}: resume may repeat implementation or findings correction`);
      requirePattern(instructions, /terceira falha[\s\S]{0,220}VALIDATE_SLICE|third failure[\s\S]{0,220}VALIDATE_SLICE/iu, "L014_AUTOMATIC_RECHECK", `${name}: third failure lacks a formal-validation continuation`);
      requirePattern(instructions, /não (?:inicie|invoque) `VALIDATE_SLICE`|do not (?:start|invoke) `VALIDATE_SLICE`/iu, "L013_CHECK_AUTHORITY", `${name}: automatic formal-validation prohibition is missing`);
      requirePattern(instructions, /TESTS_FAIL`? nas rodadas 1 ou 2|TESTS_FAIL`? in rounds 1 or 2/iu, "L014_AUTOMATIC_RECHECK", `${name}: correction is not limited to the first two failures`);
      if (spec[2] === "APPLY_FINDINGS") {
        requirePattern(instructions, /terceira falha[^\n]{0,120}(?:preserve os findings ativos|preserve active findings)|preserve os findings ativos[^\n]{0,120}terceira falha/iu, "L014_AUTOMATIC_RECHECK", `${name}: third findings failure does not preserve active findings`);
        requirePattern(instructions, /não resolve findings por si só|does not resolve findings by itself/iu, "L013_CHECK_AUTHORITY", `${name}: auxiliary non-applicability may resolve findings`);
      }
    }
  }

  for (const operation of ["execute", "apply-findings", "validate"]) {
    const signatures = ["codex", "claude"].map((platform) => {
      const { instructions } = parseLauncher(actual[`slice-${operation}-${platform}`], launcherSpecs[`slice-${operation}-${platform}`]);
      return {
        statuses: operation === "validate" ? /PASS\s*\|\s*NEEDS_FIX\s*\|\s*BLOCKED/u.test(instructions) : /TESTS_PASS[\s\S]*TESTS_FAIL[\s\S]*TESTS_NOT_APPLICABLE[\s\S]*BLOCKED/u.test(instructions),
        retry: /no máximo uma nova tentativa/iu.test(instructions),
        singleton: /Runner Initialization Blocker/u.test(instructions),
        history: /sem histórico|não envie histórico/iu.test(instructions),
        fallback: /Não faça fallback/iu.test(instructions),
        nonApplicable: /TESTS_NOT_APPLICABLE/iu.test(instructions),
        thirdFailure: /terceira falha/iu.test(instructions),
      };
    });
    if (JSON.stringify(signatures[0]) !== JSON.stringify(signatures[1])) reject("L018_PLATFORM_EQUIVALENCE", `${operation}: Codex and Claude semantic contracts diverge`);
  }
}

function checkRepository(root) {
  checkPortability(root);
  const skillsRoot = path.join(root, "skills");
  const operations = {
    "stnl-execution-planner": ["PLAN", "REPLAN"],
    "stnl-plan-reviewer": ["REVIEW_PLAN"],
    "stnl-task-materializer": ["MATERIALIZE_TASKS"],
    "stnl-task-reviewer": ["REVIEW_TASKS"],
    "stnl-slice-executor": ["EXECUTE_SLICE", "APPLY_FINDINGS"],
    "stnl-slice-quality-manager": ["VALIDATE_SLICE"],
    "stnl-execution-closer": ["CLOSE"],
    "stnl-spec-test-runbook": ["GENERATE_RUNBOOK"],
  };
  const actual = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("stnl-") && entry.name !== "stnl-spec-lifecycle-manager" && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md"))).map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(operations).sort())) reject("C002_SKILL_REGISTRY", `workflow skill registry mismatch: ${JSON.stringify(actual)}`);
  const requiredSections = ["Purpose", "Inputs", "Authority", "Minimum Reads", "Allowed Effects", "Blocks", "Output"];
  const genericTexts = [];
  for (const [name, expectedOperations] of Object.entries(operations)) {
    const file = path.join(skillsRoot, name, "SKILL.md");
    const { metadata, body } = parseFrontmatter(file);
    if (metadata.name !== name || !metadata.description) reject("C003_SKILL_SCHEMA", `invalid skill frontmatter: ${file}`);
    for (const section of requiredSections) if (!body.includes(`## ${section}`)) reject("C003_SKILL_SCHEMA", `${file}: missing ${section}`);
    const declaredOperations = [...body.matchAll(/^## ([A-Z][A-Z0-9_]*)$/gmu)].map((match) => match[1]).sort();
    if (JSON.stringify(declaredOperations) !== JSON.stringify([...expectedOperations].sort())) reject("C003_SKILL_SCHEMA", `${file}: operation set mismatch; expected=${JSON.stringify(expectedOperations)}, actual=${JSON.stringify(declaredOperations)}`);
    for (const folder of ["references", "templates", "examples", "evals"]) {
      const directory = path.join(skillsRoot, name, folder);
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const resource of realFiles(directory).filter((candidate) => candidate.endsWith(".md"))) checkFilePurposeHeader(resource, name);
    }
    if (name !== "stnl-spec-test-runbook") genericTexts.push([file, body]);
  }
  const vendor = /\bCodex\b|\bClaude(?: Code)?\b|@agent-|stnl[_-]validation[_-]runner|fork_turns|\bgpt-[0-9]|\bhaiku\b|\bsonnet\b/iu;
  for (const [file, text] of genericTexts) if (vendor.test(text)) reject("C004_VENDOR_NEUTRALITY", `${file}: generic execution skill contains vendor invocation syntax`);
  const allExecutionText = genericTexts.map(([, text]) => text).join("\n");
  for (const token of ["stnl-spec-execution-manager", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "EXECUTE_SLICES", "RUN_TESTS", "RETRY_TESTS", "FIX_TESTS", "TEST_SLICE", "TEST_FINDINGS", "VALIDATE_IMPLEMENTATION"]) {
    if (allExecutionText.includes(token)) reject("C009_REMOVED_TOKENS", `removed execution token remains: ${token}`);
  }
  const plannerContract = ["SKILL.md", "templates/plan.template.md", "templates/slice-plan.template.md"].map((relative) => read(path.join(skillsRoot, "stnl-execution-planner", relative))).join("\n");
  const taskContract = ["SKILL.md", "templates/tasks.template.md", "templates/slice-tasks.template.md"].map((relative) => read(path.join(skillsRoot, "stnl-task-materializer", relative))).join("\n");
  for (const [label, contract] of [["planning", plannerContract], ["tasks", taskContract]]) {
    if (!contract.includes("Requirements authority: sha256:<64hex>")) reject("C005_AUTHORITY_FIELDS", `${label} contract lacks exact Requirements authority field`);
    if (!contract.includes("Plan revision: <positive integer>")) reject("C005_AUTHORITY_FIELDS", `${label} contract lacks exact Plan revision field`);
  }

  const promptRoot = path.join(root, "templates/prompts");
  for (const file of realFiles(promptRoot).filter((candidate) => candidate.endsWith(".md"))) {
    const text = read(file);
    if (/SCOUT_CALL|stnl[-_]spec[-_]context[-_]scout|context[ -]scout/iu.test(text)) reject("C010_SCOUT_BOUNDARY", `launcher must not route to context scout: ${file}`);
    if (path.basename(file) !== "spec-test-runbook.md" && /GENERATE_RUNBOOK|stnl-spec-test-runbook/u.test(text)) reject("C011_RUNBOOK_ISOLATION", `implicit path invokes runbook generation: ${file}`);
  }

  checkTargets(root);
  checkLifecycleStatic(root);
  const executionSkills = Object.keys(operations).filter((name) => name !== "stnl-spec-test-runbook");
  for (const runtime of ["execution-state.mjs", "validate-execution-state.mjs"]) {
    const files = executionSkills.map((name) => path.join(skillsRoot, name, "runtime", runtime));
    for (const file of files) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) reject("C006_DISTRIBUTION", `execution skill is missing shared runtime: ${file}`);
    const authority = fs.readFileSync(files[0]);
    for (const file of files.slice(1)) if (!authority.equals(fs.readFileSync(file))) reject("C006_DISTRIBUTION", `shared runtime copies differ: ${runtime}`);
  }
  const runbookAuthorityRuntime = path.join(skillsRoot, "stnl-spec-test-runbook/runtime/execution-state.mjs");
  if (!fs.statSync(runbookAuthorityRuntime, { throwIfNoEntry: false })?.isFile()) reject("C006_DISTRIBUTION", "runbook is missing deterministic requirements-authority runtime");
  if (!fs.readFileSync(path.join(skillsRoot, executionSkills[0], "runtime/execution-state.mjs")).equals(fs.readFileSync(runbookAuthorityRuntime))) {
    reject("C006_DISTRIBUTION", "runbook requirements-authority runtime differs from execution authority");
  }
  const schemaFiles = executionSkills.map((name) => path.join(skillsRoot, name, "references/execution-record-schema.md")).filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (schemaFiles.length < 2) reject("C006_DISTRIBUTION", "execution record schema is not distributed to its consumers");
  const schemaAuthority = fs.readFileSync(schemaFiles[0]);
  for (const file of schemaFiles.slice(1)) if (!schemaAuthority.equals(fs.readFileSync(file))) reject("C006_DISTRIBUTION", `execution record schema copies differ: ${file}`);

}

function checkPortability(root) {
  for (const relative of ["scripts/validate-targets.sh", "scripts/smoke-structure.sh", "scripts/test-launcher-contract.sh", "scripts/test-validation-runner-contract.sh"]) {
    const text = read(path.join(root, relative));
    if (/(?:^|[\s"'])python(?:3)?(?:[\s"']|$)|check-contracts\.py|test-serial-workflow\.py/imu.test(text)) reject("C007_PORTABILITY", `required validation path retains Python: ${relative}`);
  }
  for (const obsolete of ["scripts/check-contracts.py", "scripts/test-serial-workflow.py"]) if (fs.existsSync(path.join(root, obsolete))) reject("C007_PORTABILITY", `obsolete Python validation entrypoint remains: ${obsolete}`);
}

function checkTargets(root) {
  const expectedAgents = ["sentinel-coder", "sentinel-orchestrator", "sentinel-planner", "sentinel-reviewer", "sentinel-test-planner", "sentinel-validator"];
  const registries = [
    ["targets/codex/.codex/agents", ".toml"],
    ["targets/claude-code/.claude/agents", ".md"],
    ["targets/copilot/.github/agents", ".agent.md"],
  ];
  for (const [relative, suffix] of registries) {
    const actual = fs.readdirSync(path.join(root, relative)).filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, -suffix.length)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedAgents)) reject("C012_TARGET_REGISTRY", `target agent registry changed: ${relative}`);
  }
  parseJson(path.join(root, "targets/claude-code/.claude/settings.json"), "C013_TARGET_CONFIG");
  parseToml(path.join(root, "targets/codex/.codex/config.toml"), "C013_TARGET_CONFIG");
  const codexPermissions = {
    "sentinel-orchestrator": "sentinel-read-only", "sentinel-planner": "sentinel-workspace", "sentinel-test-planner": "sentinel-workspace",
    "sentinel-coder": "sentinel-workspace", "sentinel-validator": "sentinel-workspace", "sentinel-reviewer": "sentinel-read-only",
  };
  const claudeTools = {
    "sentinel-orchestrator": "Read, Glob, Grep, Agent(sentinel-planner, sentinel-test-planner, sentinel-coder, sentinel-validator, sentinel-reviewer)",
    "sentinel-planner": "Read, Glob, Grep, Write, Edit", "sentinel-test-planner": "Read, Glob, Grep, Write, Edit",
    "sentinel-coder": "Read, Write, Edit, MultiEdit, Bash", "sentinel-validator": "Read, Bash", "sentinel-reviewer": "Read, Glob, Grep",
  };
  const copilotTools = {
    "sentinel-orchestrator": "[read, search, agent]", "sentinel-planner": "[read, search, edit]", "sentinel-test-planner": "[read, search, edit]",
    "sentinel-coder": "[read, edit, execute]", "sentinel-validator": "[read, execute]", "sentinel-reviewer": "[read, search]",
  };
  for (const name of expectedAgents) {
    const codex = parseToml(path.join(root, `targets/codex/.codex/agents/${name}.toml`), "C013_TARGET_CONFIG");
    if (!keysEqual(codex, { name, description: codex.description, default_permissions: codex.default_permissions, developer_instructions: codex.developer_instructions }) || codex.name !== name || codex.default_permissions !== codexPermissions[name]) reject("C013_TARGET_CONFIG", `Codex agent schema/permissions changed: ${name}`);
    const claude = parseFrontmatter(path.join(root, `targets/claude-code/.claude/agents/${name}.md`), "C013_TARGET_CONFIG");
    if (!keysEqual(claude.metadata, { name, description: claude.metadata.description, tools: claude.metadata.tools, model: claude.metadata.model }) || claude.metadata.name !== name || claude.metadata.tools !== claudeTools[name] || claude.metadata.model !== "sonnet") reject("C013_TARGET_CONFIG", `Claude agent frontmatter/tools changed: ${name}`);
    const copilot = parseFrontmatter(path.join(root, `targets/copilot/.github/agents/${name}.agent.md`), "C013_TARGET_CONFIG");
    if (!keysEqual(copilot.metadata, { name: copilot.metadata.name, description: copilot.metadata.description, tools: copilot.metadata.tools, "disable-model-invocation": copilot.metadata["disable-model-invocation"], "user-invocable": copilot.metadata["user-invocable"] }) || copilot.metadata.tools !== copilotTools[name]) reject("C013_TARGET_CONFIG", `Copilot agent frontmatter/tools changed: ${name}`);
  }
}

function checkLifecycleStatic(root) {
  const lifecycle = path.join(root, "skills/stnl-spec-lifecycle-manager");
  const cases = parseJson(path.join(lifecycle, "evals/cases.json"), "C014_LIFECYCLE_CATALOG");
  if (!Array.isArray(cases) || cases.length < 15) reject("C014_LIFECYCLE_CATALOG", "lifecycle eval catalog is incomplete");
  const contracts = parseJson(path.join(lifecycle, "evals/contract-cases.json"), "C014_LIFECYCLE_CATALOG");
  const readiness = contracts.readiness;
  if (!Array.isArray(readiness) || JSON.stringify([...new Set(readiness.map((item) => item.scope))].sort()) !== JSON.stringify(["GLOBAL", "LOCAL"])) reject("C014_LIFECYCLE_CATALOG", "READINESS positive scopes changed");
  const invalid = ["local", "global", "localized", "LOCALIZED", "Local", "Global", "repository"];
  const negatives = contracts.readiness_scope_negative_controls;
  if (!Array.isArray(negatives) || JSON.stringify(negatives.map((item) => item.value)) !== JSON.stringify(invalid) || negatives.some((item) => item.negative_control !== true || item.expected_allowed !== false)) reject("C014_LIFECYCLE_CATALOG", "READINESS negative controls changed");
  const scoutExpected = new Set(["add_second_evidence_question", "expand_allowed_roots", "replace_bounded_search_with_repository_survey"]);
  const scoutControls = contracts.scout_scope_negative_controls;
  if (!Array.isArray(scoutControls) || scoutControls.some((item) => !scoutExpected.has(item.requested_change) || item.negative_control !== true || item.expected_allowed !== false) || new Set(scoutControls.map((item) => item.requested_change)).size !== scoutExpected.size) reject("C014_LIFECYCLE_CATALOG", "context-scout scope controls changed");
  const identifiers = Object.values(contracts).flatMap((group) => Array.isArray(group) ? group.filter((item) => item && typeof item === "object" && "id" in item).map((item) => item.id) : []);
  if (new Set(identifiers).size !== identifiers.length) reject("C014_LIFECYCLE_CATALOG", "duplicate lifecycle contract IDs");
  const publicFiles = [...realFiles(lifecycle).filter((file) => /\.(?:md|json|toml)$/u.test(file)), ...realFiles(path.join(root, "templates/prompts")).filter((file) => /^spec-.*\.md$/u.test(path.basename(file)))];
  for (const file of publicFiles) {
    const text = read(file);
    if (file.endsWith(".md") && /allowed_removed_ids|--global-readiness-confirmed/u.test(text)) reject("C015_LIFECYCLE_AUTHORITY", `legacy lifecycle authority remains: ${file}`);
    if (file.endsWith("contract-cases.json")) continue;
    if (/READINESS_SCOPE\s*=\s*(?!LOCAL\|GLOBAL|\{\{READINESS_SCOPE\}\})(?:local|global|localized|repository)|`(?:local|global|localized|repository)`/u.test(text)) reject("C016_READINESS_SCOPE", `noncanonical READINESS scope remains: ${file}`);
  }
  const lifecycleText = publicFiles.filter((file) => file.startsWith(lifecycle)).map((file) => read(file)).join("\n");
  for (const [marker, label] of [
    ["never remove, renumber, reuse, fill gaps", "immutable IDs"], ["retired_reason", "tombstone reason"],
    ["runtime/create-readiness-attestation.mjs", "attestation creator"], ["--readiness-attestation", "attestation binding"],
    ["CLOSE <TARGET> <CANDIDATE> --readiness-attestation <ATTESTATION>", "publisher binding"], ["renamed backup digest before promotion", "post-rename verification"],
  ]) if (!lifecycleText.includes(marker)) reject("C015_LIFECYCLE_AUTHORITY", `lifecycle contracts lack ${label}`);
  const readme = read(path.join(lifecycle, "README.md"));
  if (!read(path.join(root, ".gitignore")).includes(".*.lifecycle.lock") || !readme.includes(".*.lifecycle.lock")) reject("C015_LIFECYCLE_AUTHORITY", "persistent publisher lock contract is missing");
}

function parseArguments(argv) {
  if (argv.length < 3) throw new InfrastructureError("usage: check-contracts.mjs <launchers|validation-runner|subagents|repository> --root PATH [--executor PATH]");
  const scope = argv[0];
  if (!["launchers", "validation-runner", "subagents", "repository"].includes(scope)) throw new InfrastructureError(`unknown scope: ${scope}`);
  let root;
  let executor;
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new InfrastructureError(`missing value for ${flag}`);
    if (flag === "--root") root = path.resolve(value);
    else if (flag === "--executor") executor = path.resolve(value);
    else throw new InfrastructureError(`unknown argument: ${flag}`);
  }
  if (!root) throw new InfrastructureError("--root is required");
  return { scope, root, executor };
}

export function run(arguments_) {
  try {
    const { scope, root } = parseArguments(arguments_);
    if (scope === "launchers") checkLaunchers(root);
    else if (scope === "validation-runner") checkRunner(root);
    else if (scope === "subagents") checkSubagents(root);
    else checkRepository(root);
    process.stdout.write(`PASS: semantic ${scope} contract: ${root}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ContractError) {
      process.stderr.write(`CONTRACT_ERROR[${error.category}]: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`INFRA_ERROR: ${error.message}\n`);
    return 2;
  }
}

const executed = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = run(process.argv.slice(2));
