#!/usr/bin/env node

import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUXILIARY_WORKFLOW_SKILLS,
  DOMAIN_SKILLS,
  EXECUTION_OPERATION_SKILLS,
  WORKFLOW_OPERATIONS,
  WORKFLOW_SKILLS,
  registrySkills,
} from "./lib/skill-registry.mjs";

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
      if (
        entry.name === ".DS_Store" ||
        entry.name.startsWith("._") ||
        entry.name === "__MACOSX" ||
        entry.name === "targets" ||
        entry.name === "node_modules"
      ) continue;
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

function checkRunner(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new InfrastructureError(`not a directory: ${root}`);
  const codexFile = path.join(root, "codex/agents/stnl_validation_runner.toml");
  const claudeFile = path.join(root, "claude-code/agents/stnl-validation-runner.md");
  const readmeFile = path.join(root, "README.md");
  for (const file of [codexFile, claudeFile, readmeFile]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) reject("R002_REGISTRY", `missing runner file: ${file}`);
  }

  const codex = parseToml(codexFile, "R013_SYNTAX");
  const claude = parseFrontmatter(claudeFile, "R013_SYNTAX");
  const description = "Planner independente de verificações e assessor formal pós-harness de uma slice.";
  const expectedCodex = {
    name: "stnl_validation_runner",
    description,
    model: "gpt-5.6-luna",
    model_reasoning_effort: "medium",
    sandbox_mode: "read-only",
    developer_instructions: codex.developer_instructions,
    agents: { max_depth: 1 },
  };
  if (!keysEqual(codex, expectedCodex)
    || Object.entries(expectedCodex).some(([key, value]) => !new Set(["developer_instructions", "agents"]).has(key) && codex[key] !== value)
    || codex.agents?.max_depth !== 1) {
    reject("R001_ADAPTER_METADATA", "Codex planner adapter metadata changed");
  }
  const expectedClaude = {
    name: "stnl-validation-runner",
    description,
    tools: "Read, Glob, Grep",
    model: "haiku",
    effort: "medium",
  };
  if (!keysEqual(claude.metadata, expectedClaude)
    || Object.entries(expectedClaude).some(([key, value]) => claude.metadata[key] !== value)) {
    reject("R001_ADAPTER_METADATA", "Claude planner adapter metadata changed");
  }

  const contract = String(codex.developer_instructions ?? "").trim();
  if (contract !== claude.body) reject("R003_EQUIVALENCE", "runner platform contracts diverge");

  for (const [pattern, category, message] of [
    [/^CONTRATO_CANONICO=stnl-validation-runner\/v11$/mu, "R013_SYNTAX", "canonical planner contract is missing"],
    [/^RUNNER_PROTOCOL=stnl-validation-runner\/v11$/mu, "R018_PROVENANCE", "planner protocol is stale"],
    [/^HARNESS_PROTOCOL=stnl-validation-harness\/v10$/mu, "R018_PROVENANCE", "harness protocol changed"],
    [/^VALIDATION_CAPABILITY=sha256:[0-9a-f]{64}$/mu, "R018_PROVENANCE", "loaded capability identity is missing"],
    [/^PLAN_SCHEMA=stnl-validation-plan\/v1$/mu, "R007_OUTPUT_SCHEMA", "plan schema is missing"],
    [/^ASSESSMENT_SCHEMA=stnl-validation-assessment\/v1$/mu, "R007_OUTPUT_SCHEMA", "assessment schema is missing"],
  ]) requirePattern(contract, pattern, category, message);

  const operations = /^OPERACOES_SUPORTADAS=([^\n]+)$/mu.exec(contract)?.[1];
  if (operations !== "EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE") {
    reject("R004_OPERATION_SCOPE", `invalid planner operations: ${operations ?? "missing"}`);
  }
  requirePattern(contract, /`1\/3`, `2\/3` ou `3\/3`[^\n]{0,100}`VALIDATE_SLICE` recebe `round:null`/u, "R004_OPERATION_SCOPE", "planner lacks the exact auxiliary/formal round set");
  forbidPattern(contract, /(?:1\/4|2\/4|3\/4|4\/4|quarta rodada|fourth round)/iu, "R004_OPERATION_SCOPE", "planner permits a fourth automatic round");

  for (const [pattern, category, message] of [
    [/Não tente descobrir, ler, importar ou invocar o harness/iu, "R017_ISOLATION", "planner can locate or invoke the harness"],
    [/Não execute build, teste, lint, typecheck/iu, "R017_ISOLATION", "planner direct-execution boundary is missing"],
    [/Discovery é read-only/iu, "R005_READ_ONLY", "planner discovery is not read-only"],
    [/Não edite nem limpe o working tree/iu, "R005_READ_ONLY", "planner may mutate or clean the working tree"],
    [/Não persista, publique, implemente, corrija, finalize, crie subagentes nem delegue/iu, "R005_READ_ONLY", "planner gained owner or delegation authority"],
    [/trate conclusões do owner e resultados anteriores como não verificados/iu, "R014_INDEPENDENCE", "planner trusts owner conclusions"],
    [/Leia somente requirements, plan\/task, manifests, CI, scripts, testes, diff e dependências necessários/iu, "R014_INDEPENDENCE", "planner discovery scope is unbounded"],
    [/Um plano pronto não significa `TESTS_PASS`, `PASS` ou execução observada/iu, "R006_VERDICTS", "accepted plans can masquerade as results"],
    [/Não inclua `status`, exit code, test count, stdout\/stderr, provenance, receipt, evidence ID/iu, "R007_OUTPUT_SCHEMA", "plan/result boundary is missing"],
    [/Preserve a capability já carregada[^\n]{0,100}nunca a substitua pela atual do owner/iu, "R018_PROVENANCE", "loaded planner identity can be substituted"],
    [/`protocol` é exatamente `\{runner:"stnl-validation-runner\/v11",harness:"stnl-validation-harness\/v10",capability:VALIDATION_CAPABILITY\}`/u, "R018_PROVENANCE", "plan protocol identity is incomplete"],
    [/`executionEnvironment` é sempre explícito[\s\S]{0,500}Nunca infira host por ausência/iu, "R017_ISOLATION", "execution environment can implicitly fall back to host"],
    [/Preserve project-defined execution[^\n]{0,180}ausência de fallback/iu, "R017_ISOLATION", "project-defined execution or no-fallback boundary is missing"],
    [/Ferramenta ou ambiente ausente não é não aplicabilidade/iu, "R016_NOT_APPLICABLE", "tool unavailability is confused with non-applicability"],
    [/Plano sem commands requer discovery real[^\n]{0,120}`nonApplicabilityRationale` objetivo[^\n]{0,100}não vira sucesso/iu, "R016_NOT_APPLICABLE", "non-applicability lacks objective discovery and rationale"],
    [/`assessment` é `independent` em `VALIDATE_SLICE`/u, "R014_INDEPENDENCE", "formal validation lacks independent assessment"],
    [/Somente quando o owner solicitar explicitamente assessment/iu, "R014_INDEPENDENCE", "post-harness assessment boundary is missing"],
    [/não peça nem copie o envelope[^\n]{0,100}não execute checks[^\n]{0,100}não reconstrua evidence/iu, "R018_PROVENANCE", "assessment can access or reconstruct opaque evidence"],
    [/O assessment não publica/iu, "R015_CHECK_AUTHORITY", "assessment gained publication authority"],
    [/PASS`\/`ACCEPTED` formal exige assessment independente completo e candidate validation pelo owner/iu, "R015_CHECK_AUTHORITY", "formal publication can bypass assessment or owner validation"],
    [/Descoberta, bridge execution e assessment não alocam nova rodada de correção/iu, "R004_OPERATION_SCOPE", "planning or assessment can consume a correction round"],
  ]) requirePattern(contract, pattern, category, message);

  forbidPattern(contract, /VALIDATION_HARNESS_PATH|<SKILL_ROOT>|resolve-validation-runtime\.mjs|run-validation-session\.mjs/iu, "R017_ISOLATION", "planner exposes physical validation infrastructure");
  forbidPattern(contract, /Em `(?:EXECUTE_SLICE|APPLY_FINDINGS)`[^\n]{0,160}(?:publique|emita|crie)[^\n]{0,80}(?:PASS formal|Validation Attempt|Effective Validation Base|conclusão `\[x\]`)/iu, "R015_CHECK_AUTHORITY", "auxiliary planning claims formal authority");

  const readme = read(readmeFile, "R012_README");
  for (const marker of [
    "stnl-validation-runner/v11",
    "Ele não localiza nem invoca o harness",
    "skill dona chama seu bridge",
    "remove Bash",
  ]) {
    if (!readme.includes(marker)) reject("R012_README", `integration README lacks ${marker}`);
  }
}
function checkScout(root) {
  const codexFile = path.join(root, "codex/agents/stnl_spec_context_scout.toml");
  const claudeFile = path.join(root, "claude-code/agents/stnl-spec-context-scout.md");
  const codex = parseToml(codexFile, "S007_SYNTAX");
  const claude = parseFrontmatter(claudeFile, "S007_SYNTAX");
  const description = "Read-only exception scout for one explicitly authorized lifecycle evidence gap; never auto-select or delegate.";
  const expectedCodex = {
    name: "stnl_spec_context_scout", description, model: "gpt-5.6-luna", model_reasoning_effort: "medium",
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
    "codex/agents/stnl_validation_runner.toml",
    "codex/agents/stnl_spec_context_scout.toml",
    "claude-code/agents/stnl-validation-runner.md",
    "claude-code/agents/stnl-spec-context-scout.md",
  ]);
  const actual = new Set(["codex", "claude-code"].flatMap((platform) => {
    const agents = path.join(root, platform, "agents");
    if (!fs.statSync(agents, { throwIfNoEntry: false })?.isDirectory()) reject("S002_REGISTRY", `missing agents directory: ${agents}`);
    return realFiles(agents).map((file) => path.relative(root, file).split(path.sep).join("/"));
  }));
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) reject("S002_REGISTRY", `subagent registry mismatch; actual=${JSON.stringify([...actual].sort())}`);
  for (const nestedRoot of ["codex/.codex", "codex/.claude", "claude-code/.codex", "claude-code/.claude"]) {
    if (fs.existsSync(path.join(root, nestedRoot))) reject("S002_REGISTRY", `native installation path must not exist in canonical sources: ${nestedRoot}`);
  }
  checkRunner(root);
  checkScout(root);
}

const launcherSpecs = {
  "spec-init": ["stnl-spec-lifecycle-manager", "MODE", "INIT", [["SPEC_PATH", "{{SPEC_PATH}}"], ["REQUIREMENTS_SOURCE", "{{REQUIREMENTS_SOURCE}}"]]],
  "spec-resume": ["stnl-spec-lifecycle-manager", "MODE", "RESUME", [["SPEC_PATH", "{{SPEC_PATH}}"], ["NEW_INFORMATION", "{{NEW_INFORMATION}}"]]],
  "spec-readiness": ["stnl-spec-lifecycle-manager", "MODE", "READINESS", [["SPEC_PATH", "{{SPEC_PATH}}"], ["READINESS_SCOPE", "{{READINESS_SCOPE}}"], ["READINESS_FOCUS", "{{READINESS_FOCUS}}"]]],
  "spec-close": ["stnl-spec-lifecycle-manager", "MODE", "CLOSE", [["SPEC_PATH", "{{SPEC_PATH}}"]]],
  "spec-test-runbook": ["stnl-spec-test-runbook", "OPERATION", "GENERATE_RUNBOOK", [["SPEC_PATH", "{{SPEC_PATH}}"], ["RUNBOOK_SCOPE", "{{RUNBOOK_SCOPE}}"], ["RUNBOOK_SELECTION", "{{RUNBOOK_SELECTION}}"], ["RUNBOOK_OPTIONS", "{{RUNBOOK_OPTIONS}}"]]],
  "requirements-refinement-init": ["stnl-requirements-refiner", "OPERATION", "INIT", [["PROJECT_ROOT", "{{PROJECT_ROOT}}"], ["REFINEMENT_PATH", "{{REFINEMENT_PATH}}"], ["REQUIREMENTS_SOURCE", "{{REQUIREMENTS_SOURCE}}"]]],
  "requirements-refinement-reconcile": ["stnl-requirements-refiner", "OPERATION", "RECONCILE", [["PROJECT_ROOT", "{{PROJECT_ROOT}}"], ["REFINEMENT_PATH", "{{REFINEMENT_PATH}}"], ["NEW_INFORMATION", "{{NEW_INFORMATION}}"]]],
  "spec-roadmap-init": ["stnl-spec-roadmap", "OPERATION", "INIT", [["PROJECT_ROOT", "{{PROJECT_ROOT}}"], ["ROADMAP_PATH", "{{ROADMAP_PATH}}"], ["ROADMAP_SOURCE", "{{ROADMAP_SOURCE}}"]]],
  "spec-roadmap-reconcile": ["stnl-spec-roadmap", "OPERATION", "RECONCILE", [["PROJECT_ROOT", "{{PROJECT_ROOT}}"], ["ROADMAP_PATH", "{{ROADMAP_PATH}}"], ["NEW_INFORMATION", "{{NEW_INFORMATION}}"]]],
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
const sharedExecution = new Set([
  "execution-plan", "execution-replan", "execution-plan-review", "execution-tasks", "execution-tasks-review", "execution-close",
  "requirements-refinement-init", "requirements-refinement-reconcile", "spec-roadmap-init", "spec-roadmap-reconcile",
]);

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
  const expected = spec[3].filter(([, value]) => value.startsWith("{{") && value.endsWith("}}"))
    .map(([key]) => key).sort();
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
      requirePattern(instructions, /planning-only atomic replacement[\s\S]{0,120}revision 1[\s\S]{0,160}materialized-pristine replacement[\s\S]{0,160}append-only extension/iu, "L019_RECOVERY_TARGET", "REPLAN launcher does not distinguish all three mutation classes");
    }
    if (name === "spec-readiness") {
      requirePattern(instructions, /(?:only|somente).{0,40}`LOCAL`.{0,30}`GLOBAL`|`LOCAL`.{0,30}`GLOBAL`.{0,80}(?:case-sensitive|sem aliases)/iu, "L015_READINESS_SCOPE", "READINESS exact scope set is missing");
      requirePattern(instructions, /READINESS_FOCUS.{0,100}(?:obrigat|required)/iu, "L015_READINESS_SCOPE", "LOCAL focus requirement is missing");
      forbidPattern(instructions, /`(?:local|global|localized|repository)`/u, "L015_READINESS_SCOPE", "READINESS scope alias is present");
    }
    if (name === "spec-test-runbook") {
      for (const key of ["audience", "test_types", "environment", "depth", "data_preparation", "evidence", "presentation", "helpers", "locale"]) {
        requirePattern(instructions, new RegExp(`\\b${key}\\b`, "u"), "L020_RUNBOOK_OPTIONS", `runbook launcher omits canonical option ${key}`);
      }
      requirePattern(instructions, /locale.{0,80}`en-US`.{0,30}`pt-BR`|`en-US`.{0,30}`pt-BR`.{0,80}locale/iu, "L020_RUNBOOK_OPTIONS", "runbook launcher omits the exact locale set");
      requirePattern(instructions, /locale="en-US"/u, "L020_RUNBOOK_OPTIONS", "runbook launcher omits the en-US default");
      requirePattern(instructions, /não (?:é |será )?detectado automaticamente|sem detecção automática|never (?:automatically )?detected/iu, "L020_RUNBOOK_OPTIONS", "runbook launcher permits automatic locale detection");
      requirePattern(instructions, /pt_BR.{0,60}pt-br.{0,60}es-ES.{0,60}auto.{0,60}system/u, "L020_RUNBOOK_OPTIONS", "runbook launcher omits representative invalid locales");
      requirePattern(instructions, /Chaves desconhecidas.{0,100}tipos incorretos.{0,100}enums inválidos.{0,100}arrays inválidos/iu, "L020_RUNBOOK_OPTIONS", "runbook launcher omits deterministic rejection rules");
      requirePattern(instructions, /Exemplo em inglês[\s\S]{0,500}"en-US"/u, "L020_RUNBOOK_OPTIONS", "runbook launcher omits the en-US example");
      requirePattern(instructions, /Exemplo em português do Brasil[\s\S]{0,800}"pt-BR"/u, "L020_RUNBOOK_OPTIONS", "runbook launcher omits the pt-BR example");
    }
    if (name.startsWith("spec-roadmap-")) {
      requirePattern(instructions, /roadmap\.json/u, "L021_ROADMAP_BOUNDARY", `${name}: roadmap authority is missing`);
      requirePattern(instructions, /browser.{0,120}(?:não é|never).{0,80}(?:Sentinel|authority|autoridade)/iu, "L021_ROADMAP_BOUNDARY", `${name}: browser-state boundary is missing`);
      requirePattern(instructions, /não (?:crie|altere|invoque).{0,100}SPEC|do not (?:create|change|invoke).{0,100}SPEC/iu, "L021_ROADMAP_BOUNDARY", `${name}: SPEC mutation boundary is missing`);
    }
    if (name.startsWith("requirements-refinement-")) {
      requirePattern(instructions, /refinement\.json/u, "L022_REFINEMENT_BOUNDARY", `${name}: refinement authority is missing`);
      requirePattern(instructions, /browser.{0,120}(?:não é|never).{0,80}(?:Sentinel|authority|autoridade)/iu, "L022_REFINEMENT_BOUNDARY", `${name}: browser-state boundary is missing`);
      requirePattern(instructions, /não (?:crie|altere|invoque).{0,100}SPEC.{0,80}Roadmap.{0,80}(?:workflow )?downstream/iu, "L022_REFINEMENT_BOUNDARY", `${name}: downstream mutation boundary is missing`);
      requirePattern(instructions, /handoff manual/iu, "L022_REFINEMENT_BOUNDARY", `${name}: manual handoff boundary is missing`);
    }
    if (!runnerLaunchers.has(name)) continue;
    forbidPattern(text, /VALIDATION_HARNESS_PATH|<SKILL_ROOT>|resolve-validation-runtime\.mjs|run-validation-session\.mjs|(?:^|\/)runtime\/[A-Za-z0-9._/-]*validation[A-Za-z0-9._/-]*/iu, "L004_INPUTS", `${name}: internal validation path leaked into the operator contract`);
    forbidPattern(text, /`SPEC_PATH`, execution root derivado|paths de plans e tasks/iu, "L004_INPUTS", `${name}: derivable execution paths leaked into the delegated payload`);
    for (const [pattern, category, message] of [
      [/stnl-validation-plan\/v1/u, "L012_CHECK_DELEGATION", "planner output schema is missing"],
      [/loaded (?:skill location|owner package|bridge)|loaded packaged bridge/iu, "L012_CHECK_DELEGATION", "owner bridge bootstrap is missing"],
      [/does not execute|neither executes|não execute verification commands diretamente/iu, "L013_CHECK_AUTHORITY", "planner execution boundary is missing"],
      [/result-shaped|statuses\/exits\/counts\/provenance/iu, "L013_CHECK_AUTHORITY", "plan/result rejection is missing"],
      [/Não faça fallback/iu, "L008_VALIDATION_FLOW", "fallback is enabled"],
      [/read-back/iu, "L008_VALIDATION_FLOW", "candidate read-back is missing"],
      [/concrete recovery operation and slice returned by deterministic preflight[\s\S]{0,100}derive neither from this request/iu, "L019_RECOVERY_TARGET", "state-derived recovery target is missing"],
      [/owner (?:then )?invokes? (?:the |its )?(?:loaded )?(?:packaged )?bridge/iu, "L013_CHECK_AUTHORITY", "owner-to-bridge authority is missing"],
      [/(?:isolated candidate|stages derived[\s\S]{0,120}candidate)/iu, "L008_VALIDATION_FLOW", "candidate staging boundary is missing"],
    ]) requirePattern(instructions, pattern, category, `${name}: ${message}`);
    const currentIsCodex = name.endsWith("-codex");
    if (currentIsCodex) {
      if ((text.match(/stnl_validation_runner/gu) ?? []).length !== 1 || text.includes("@agent-")) reject("L007_PLATFORM_IDENTITY", `${name}: invalid Codex planner identity`);
      requirePattern(instructions, /spawn obrigatório/iu, "L007_PLATFORM_IDENTITY", `${name}: mandatory Codex planner spawn is missing`);
      requirePattern(instructions, /fork_turns="none"/u, "L016_TRANSPORT", `${name}: Codex planner must start without inherited turns`);
    } else {
      if ((text.match(/@agent-stnl-validation-runner/gu) ?? []).length !== 1 || text.includes("stnl_validation_runner")) reject("L007_PLATFORM_IDENTITY", `${name}: invalid Claude planner identity`);
      requirePattern(instructions, /delegue obrigatoriamente/iu, "L007_PLATFORM_IDENTITY", `${name}: mandatory Claude planner delegation is missing`);
    }
    requirePattern(instructions, /sem histórico|no[^\n]{0,40}conversation history|no inherited thread/iu, "L012_CHECK_DELEGATION", `${name}: no-history boundary is missing`);
    forbidPattern(instructions, /(?:(?<!não )envie|(?<!do not )forward|(?<!do not )include)[^\n]{0,40}(?:histórico da conversa|conversation history|inherited thread)/iu, "L012_CHECK_DELEGATION", `${name}: conversation history is forwarded`);
    requirePattern(instructions, /at most one|no máximo uma nova tentativa/iu, "L012_CHECK_DELEGATION", `${name}: initialization retry is not bounded`);
    requirePattern(instructions, /Malformed (?:planner )?output has no (?:transport )?retry|malformed planner output does not receive transport retry|saída malformada[^\n]{0,100}não recebe retry/iu, "L016_TRANSPORT", `${name}: malformed output is confused with transport initialization`);
    forbidPattern(instructions, /(?<!Não )Faça fallback|(?<!Do not )use fallback|fallback (?:is )?(?:enabled|allowed)|fallback para host/iu, "L008_VALIDATION_FLOW", `${name}: fallback is enabled`);
    requirePattern(instructions, /(?:do not send|never send|não (?:passe|envie|encaminhe))[^\n]{0,180}(?:full logs|logs)/iu, "L012_CHECK_DELEGATION", `${name}: minimum-payload log boundary is missing`);
    if (spec[2] === "VALIDATE_SLICE") {
      requirePattern(instructions, /stnl-validation-assessment\/v1/u, "L008_VALIDATION_FLOW", `${name}: independent assessment phase is missing`);
      requirePattern(instructions, /Exit 0 or accepted plan alone cannot publish/iu, "L013_CHECK_AUTHORITY", `${name}: accepted plan can publish formal success`);
      requirePattern(instructions, /PASS\s*\|\s*ACCEPTED\s*\|\s*NEEDS_FIX\s*\|\s*BLOCKED/u, "L008_VALIDATION_FLOW", `${name}: formal status set changed`);
      requirePattern(instructions, /(?:Exija|Require)[^\n]{0,60}(?:revisão|review) independente[^\n]{0,100}(?:non-applicability|não aplicabilidade)/iu, "L008_VALIDATION_FLOW", `${name}: non-applicability is not independently reviewed`);
      forbidPattern(instructions, /(?<!Não )Promova não aplicabilidade a `PASS`|(?<!do not )promote non-applicability to `?PASS`?/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability is promoted to PASS`);
      requirePattern(instructions, /não repete testes|does not (?:repeat|run)[^\n]{0,40}tests/iu, "L013_CHECK_AUTHORITY", `${name}: formal assessment may repeat checks`);
      requirePattern(instructions, /(?:do not|não) (?:create\/consume|criam? nem consomem?)[^\n]{0,40}`?attempt-NN`?/iu, "L016_TRANSPORT", `${name}: transport failure may allocate a formal attempt`);
      requirePattern(instructions, /(?:do not change|do not create\/consume[^\n]{0,80}or change|não mudam?)[^\n]{0,40}initial[^\n]{0,40}revalidation/iu, "L016_TRANSPORT", `${name}: transport failure may change validation type`);
    } else {
      requirePattern(instructions, /(?:no mínimo uma vez|at least once)[\s\S]{0,80}(?:no máximo três vezes|at most three times)/iu, "L014_AUTOMATIC_RECHECK", `${name}: one-to-three planning budget is missing`);
      requirePattern(instructions, /1\/3[\s\S]{0,40}2\/3[\s\S]{0,40}3\/3/u, "L014_AUTOMATIC_RECHECK", `${name}: round set is missing`);
      requirePattern(instructions, /TESTS_NOT_APPLICABLE[\s\S]{0,180}(?:objective discovery|descoberta objetiva)[\s\S]{0,180}(?:nenhum comando|no-command)/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability proof is missing`);
      forbidPattern(instructions, /(?<!never )make a fourth call|(?<!nunca )faça uma quarta chamada|use (?:an )?unbounded loop|loop ilimitado/iu, "L014_AUTOMATIC_RECHECK", `${name}: auxiliary planning cycle is unbounded`);
      forbidPattern(instructions, /(?:zero a três|zero to three|planner invocation is optional|Pode invocar o planner)/iu, "L014_AUTOMATIC_RECHECK", `${name}: planner invocation became optional`);
      forbidPattern(instructions, /(?<!Never )(?<!Do not )(?<!Não )(?:Create|Crie|Emita|Marque)[^\n]{0,80}(?:Validation Attempt|Effective Validation Base|PASS formal|`\[x\]`)/iu, "L013_CHECK_AUTHORITY", `${name}: auxiliary check claims formal authority`);
      requirePattern(instructions, /(?:attempts?|tentativas?|it)[^\n]{0,60}(?:não consomem?|does not consume|do not consume)[^\n]{0,40}(?:rodada|round)/iu, "L016_TRANSPORT", `${name}: transport failure may consume an auxiliary round`);
      requirePattern(instructions, /(?:do not create|does not create|não criam?)[^\n]{0,50}(?:implementation|findings)-check-NN/iu, "L016_TRANSPORT", `${name}: transport failure may allocate auxiliary evidence`);
      requirePattern(instructions, /(?:do not authorize|does not create[^\n]{0,80}or authorize|não autorizam?)[^\n]{0,30}correction|(?:do not authorize|não autorizam?)[^\n]{0,30}correção/iu, "L016_TRANSPORT", `${name}: transport failure may authorize correction`);
      requirePattern(instructions, /(?:without|sem|não)[^\n]{0,80}(?:reimplementation|reimplement|reaplique findings)/iu, "L016_TRANSPORT", `${name}: resume may repeat implementation or findings correction`);
      requirePattern(instructions, /(?:round 3|terceira falha)[\s\S]{0,180}(?:VALIDATE_SLICE|única próxima ação)|(?:VALIDATE_SLICE|única próxima ação)[\s\S]{0,180}(?:round 3|terceira falha)/iu, "L014_AUTOMATIC_RECHECK", `${name}: third failure lacks formal-validation continuation`);
      requirePattern(instructions, /TESTS_FAIL[^\n]{0,40}(?:rounds 1 or 2|rodadas 1 ou 2)/iu, "L014_AUTOMATIC_RECHECK", `${name}: correction is not limited to the first two failures`);
      if (spec[2] === "APPLY_FINDINGS") {
        requirePattern(instructions, /(?:round 3|terceira falha)[^\n]{0,120}(?:preserves? active findings|preserva? os findings ativos)|(?:preserves? active findings|preserva? os findings ativos)[^\n]{0,120}(?:round 3|terceira falha)/iu, "L014_AUTOMATIC_RECHECK", `${name}: third findings failure does not preserve active findings`);
        requirePattern(instructions, /não resolve findings por si só|does not resolve findings by itself/iu, "L013_CHECK_AUTHORITY", `${name}: non-applicability may resolve findings`);
      }
    }
  }

  for (const operation of ["execute", "apply-findings", "validate"]) {
    const signatures = ["codex", "claude"].map((platform) => {
      const { instructions } = parseLauncher(actual[`slice-${operation}-${platform}`], launcherSpecs[`slice-${operation}-${platform}`]);
      return {
        formal: operation === "validate",
        plan: /stnl-validation-plan\/v1/u.test(instructions),
        bridge: /loaded (?:skill location|bridge)|loaded packaged bridge/iu.test(instructions),
        retry: /no máximo uma nova tentativa|at most one/iu.test(instructions),
        history: /sem histórico|no[^\n]{0,40}conversation history|no inherited thread/iu.test(instructions),
        fallback: /Não faça fallback/iu.test(instructions),
        readBack: /read-back/iu.test(instructions),
        nonApplicable: /TESTS_NOT_APPLICABLE/iu.test(instructions),
        thirdFailure: operation === "validate" ? null : /round 3|terceira falha/iu.test(instructions),
        assessment: operation === "validate" ? /stnl-validation-assessment\/v1/u.test(instructions) : null,
        recoveryHistory: operation === "execute"
          ? /preserve[^\n]{0,60}historical[^\n]{0,40}(?:blocker|blockers)/iu.test(instructions)
          : operation === "validate" ? /Preserve the singleton Delegation Blocker/iu.test(instructions) : null,
      };
    });
    if (JSON.stringify(signatures[0]) !== JSON.stringify(signatures[1])) reject("L018_PLATFORM_EQUIVALENCE", `${operation}: Codex and Claude semantic contracts diverge`);
  }
}

function checkValidationEnvironmentOwner(workflowRoot, name, body) {
  const referenceFile = path.join(workflowRoot, name, "references/validation-environment-selection.md");
  const reference = read(referenceFile, "C020_VALIDATION_ENVIRONMENT_AUTHORITY");
  for (const [pattern, message] of [
    [/"scope":"optionId"/u, "optionId choice form is missing"],
    [/configurationPath[\s\S]{0,120}service/u, "direct Compose confirmation form is missing"],
    [/cacheVolumes[\s\S]{0,180}explicitly confirms/iu, "explicit cache confirmation boundary is missing"],
    [/instructionReferences[\s\S]{0,180}not documentary authority/iu, "prose reference/authority distinction is missing"],
    [/Never fabricate `authoritySources`/u, "owner may fabricate documentary authority"],
    [/planner as a read-only restriction[\s\S]{0,220}separately to `--execute-plan`/iu, "planner/bridge selection separation is missing"],
    [/bridge, not the owner or planner, binds/iu, "plan can act as its own operational authority"],
  ]) requirePattern(reference, pattern, "C020_VALIDATION_ENVIRONMENT_AUTHORITY", `${name}: ${message}`);
  requirePattern(body, /references\/validation-environment-selection\.md/u,
    "C020_VALIDATION_ENVIRONMENT_AUTHORITY", `${name}: owner does not load the environment selection reference`);
  forbidPattern(body, /only explicit operator option IDs/iu,
    "C020_VALIDATION_ENVIRONMENT_AUTHORITY", `${name}: legacy optionId-only instruction remains`);
}

function checkValidationEnvironmentOwners(root) {
  const workflowRoot = path.join(root, "skills", "workflows");
  for (const name of ["stnl-slice-executor", "stnl-slice-quality-manager"]) {
    const { body } = parseFrontmatter(path.join(workflowRoot, name, "SKILL.md"));
    checkValidationEnvironmentOwner(workflowRoot, name, body);
  }
}

function checkRepository(root) {
  checkPortability(root);
  const skillsRoot = path.join(root, "skills");
  for (const relative of [
    "scripts/lib/skill-registry.mjs",
    "scripts/lib/skill-discovery.mjs",
    "scripts/lib/skill-routing.mjs",
    "integrations/codex/skill-discovery.mjs",
    "integrations/claude-code/skill-discovery.mjs",
  ]) {
    if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()) reject("C017_SKILL_INTEGRATION", `missing skill integration: ${relative}`);
  }
  const workflowRoot = path.join(skillsRoot, "workflows");
  const domainRoot = path.join(skillsRoot, "domains");
  const operations = WORKFLOW_OPERATIONS;
  const registry = registrySkills();
  if (new Set(registry).size !== registry.length) reject("C002_SKILL_REGISTRY", "workflow and domain registries contain duplicate names");
  if (WORKFLOW_SKILLS.some((name) => DOMAIN_SKILLS.includes(name))) reject("C002_SKILL_REGISTRY", "workflow and domain registries overlap");

  function directSkillNames(directory) {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) reject("C002_SKILL_REGISTRY", `missing skill family directory: ${directory}`);
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("stnl-"))
      .map((entry) => entry.name)
      .sort();
  }

  const actualWorkflows = directSkillNames(workflowRoot);
  const actualDomains = directSkillNames(domainRoot);
  if (JSON.stringify(actualWorkflows) !== JSON.stringify([...WORKFLOW_SKILLS].sort())) reject("C002_SKILL_REGISTRY", `workflow skill registry mismatch: ${JSON.stringify(actualWorkflows)}`);
  if (JSON.stringify(actualDomains) !== JSON.stringify([...DOMAIN_SKILLS].sort())) reject("C002_SKILL_REGISTRY", `domain skill registry mismatch: ${JSON.stringify(actualDomains)}`);
  for (const name of registry) {
    if (fs.existsSync(path.join(skillsRoot, name))) reject("C002_SKILL_REGISTRY", `flat skill duplicate remains: skills/${name}`);
  }

  const requiredSections = ["Purpose", "Inputs", "Authority", "Minimum Reads", "Allowed Effects", "Blocks", "Output"];
  const genericTexts = [];
  for (const [name, expectedOperations] of Object.entries(operations)) {
    const file = path.join(workflowRoot, name, "SKILL.md");
    const { metadata, body } = parseFrontmatter(file);
    if (metadata.name !== name || !metadata.description) reject("C003_SKILL_SCHEMA", `invalid skill frontmatter: ${file}`);
    const validationOwner = name === "stnl-slice-executor" || name === "stnl-slice-quality-manager";
    if (validationOwner && metadata["validation-runtime"] !== "runtime/run-validation-session.mjs") {
      reject("C003_SKILL_SCHEMA", `${file}: missing canonical internal validation runtime declaration`);
    }
    if (!validationOwner && Object.hasOwn(metadata, "validation-runtime")) {
      reject("C003_SKILL_SCHEMA", `${file}: non-owner declares a validation runtime`);
    }
    if (validationOwner) checkValidationEnvironmentOwner(workflowRoot, name, body);
    for (const section of requiredSections) if (!body.includes(`## ${section}`)) reject("C003_SKILL_SCHEMA", `${file}: missing ${section}`);
    const declaredOperations = [...body.matchAll(/^## ([A-Z][A-Z0-9_]*)$/gmu)].map((match) => match[1]).sort();
    if (JSON.stringify(declaredOperations) !== JSON.stringify([...expectedOperations].sort())) reject("C003_SKILL_SCHEMA", `${file}: operation set mismatch; expected=${JSON.stringify(expectedOperations)}, actual=${JSON.stringify(declaredOperations)}`);
    for (const folder of ["references", "templates", "examples", "evals"]) {
      const directory = path.join(workflowRoot, name, folder);
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const resource of realFiles(directory).filter((candidate) => candidate.endsWith(".md"))) checkFilePurposeHeader(resource, name);
    }
    if (!AUXILIARY_WORKFLOW_SKILLS.includes(name)) genericTexts.push([file, body]);
  }
  const lifecycleFile = path.join(workflowRoot, "stnl-spec-lifecycle-manager", "SKILL.md");
  const lifecycleSkill = parseFrontmatter(lifecycleFile);
  if (lifecycleSkill.metadata.name !== "stnl-spec-lifecycle-manager" || !lifecycleSkill.metadata.description) reject("C003_SKILL_SCHEMA", `invalid skill frontmatter: ${lifecycleFile}`);
  for (const name of DOMAIN_SKILLS) {
    const file = path.join(domainRoot, name, "SKILL.md");
    const { metadata, body } = parseFrontmatter(file);
    if (metadata.name !== name || !metadata.description || !body) reject("C003_SKILL_SCHEMA", `invalid domain skill schema: ${file}`);
  }
  const vendor = /\bCodex\b|\bClaude(?: Code)?\b|@agent-|stnl[_-]validation[_-]runner|fork_turns|\bgpt-[0-9]|\bhaiku\b|\bsonnet\b/iu;
  for (const [file, text] of genericTexts) if (vendor.test(text)) reject("C004_VENDOR_NEUTRALITY", `${file}: generic execution skill contains vendor invocation syntax`);
  const allExecutionText = genericTexts.map(([, text]) => text).join("\n");
  for (const token of ["stnl-spec-execution-manager", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "EXECUTE_SLICES", "RUN_TESTS", "RETRY_TESTS", "FIX_TESTS", "TEST_SLICE", "TEST_FINDINGS", "VALIDATE_IMPLEMENTATION"]) {
    if (allExecutionText.includes(token)) reject("C009_REMOVED_TOKENS", `removed execution token remains: ${token}`);
  }
  const plannerContract = ["SKILL.md", "templates/plan.template.md", "templates/slice-plan.template.md"].map((relative) => read(path.join(workflowRoot, "stnl-execution-planner", relative))).join("\n");
  const taskContract = ["SKILL.md", "templates/tasks.template.md", "templates/slice-tasks.template.md"].map((relative) => read(path.join(workflowRoot, "stnl-task-materializer", relative))).join("\n");
  for (const [label, contract] of [["planning", plannerContract], ["tasks", taskContract]]) {
    if (!contract.includes("Requirements authority: sha256:<64hex>")) reject("C005_AUTHORITY_FIELDS", `${label} contract lacks exact Requirements authority field`);
    if (!contract.includes("Plan revision: <positive integer>")) reject("C005_AUTHORITY_FIELDS", `${label} contract lacks exact Plan revision field`);
  }

  const promptRoot = path.join(root, "templates/prompts");
  for (const file of realFiles(promptRoot).filter((candidate) => candidate.endsWith(".md"))) {
    const text = read(file);
    if (/SCOUT_CALL|stnl[-_]spec[-_]context[-_]scout|context[ -]scout/iu.test(text)) reject("C010_SCOUT_BOUNDARY", `launcher must not route to context scout: ${file}`);
    if (path.basename(file) !== "spec-test-runbook.md" && /GENERATE_RUNBOOK|stnl-spec-test-runbook/u.test(text)) reject("C011_RUNBOOK_ISOLATION", `implicit path invokes runbook generation: ${file}`);
    if (!path.basename(file).startsWith("spec-roadmap-") && /stnl-spec-roadmap/u.test(text)) reject("C018_ROADMAP_ISOLATION", `implicit path invokes roadmap operation: ${file}`);
    if (!path.basename(file).startsWith("requirements-refinement-") && /stnl-requirements-refiner/u.test(text)) reject("C019_REFINEMENT_ISOLATION", `implicit path invokes requirements refinement: ${file}`);
  }

  checkLifecycleStatic(root);
  checkRefinementStatic(root);
  const executionSkills = [...EXECUTION_OPERATION_SKILLS];
  for (const runtime of ["execution-state.mjs", "validate-execution-state.mjs"]) {
    const files = executionSkills.map((name) => path.join(workflowRoot, name, "runtime", runtime));
    for (const file of files) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) reject("C006_DISTRIBUTION", `execution skill is missing shared runtime: ${file}`);
    const authority = fs.readFileSync(files[0]);
    for (const file of files.slice(1)) if (!authority.equals(fs.readFileSync(file))) reject("C006_DISTRIBUTION", `shared runtime copies differ: ${runtime}`);
  }
  for (const runtime of ["resolve-validation-runtime.mjs", "run-validation-session.mjs"]) {
    const files = ["stnl-slice-executor", "stnl-slice-quality-manager"]
      .map((name) => path.join(workflowRoot, name, "runtime", runtime));
    for (const file of files) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      reject("C006_DISTRIBUTION", `validation owner is missing shared validation runtime: ${file}`);
    }
    if (!fs.readFileSync(files[0]).equals(fs.readFileSync(files[1]))) {
      reject("C006_DISTRIBUTION", `validation runtime copies differ: ${runtime}`);
    }
  }
  for (const auxiliary of AUXILIARY_WORKFLOW_SKILLS) {
    const authorityRuntime = path.join(workflowRoot, auxiliary, "runtime/execution-state.mjs");
    if (!fs.statSync(authorityRuntime, { throwIfNoEntry: false })?.isFile()) reject("C006_DISTRIBUTION", `${auxiliary} is missing deterministic requirements-authority runtime`);
    if (!fs.readFileSync(path.join(workflowRoot, executionSkills[0], "runtime/execution-state.mjs")).equals(fs.readFileSync(authorityRuntime))) {
      reject("C006_DISTRIBUTION", `${auxiliary} requirements-authority runtime differs from execution authority`);
    }
  }
  const schemaFiles = executionSkills.map((name) => path.join(workflowRoot, name, "references/execution-record-schema.md")).filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
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

function checkLifecycleStatic(root) {
  const lifecycle = path.join(root, "skills/workflows/stnl-spec-lifecycle-manager");
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

function checkRefinementStatic(root) {
  const skill = path.join(root, "skills/workflows/stnl-requirements-refiner");
  const cases = parseJson(path.join(skill, "evals/cases.json"), "C019_REFINEMENT_ISOLATION");
  const expected = new Set([
    "messy-free-text", "structured-story", "multi-source-sprint", "finding-families", "bounded-evidence",
    "insufficient-evidence", "resolution-accepted", "resolution-rejected", "resolution-inconclusive",
    "explicit-bypass", "finding-reopen", "handoff-blocked", "handoff-direct-spec",
    "handoff-multi-domain-roadmap", "cancellation-race", "inadequate-race-resolution",
    "retry-policy-bypass", "stale-reconcile", "publication-collision", "deterministic-render",
    "desktop-mobile-visual", "offline-keyboard-filters", "print-completeness",
  ]);
  if (!Array.isArray(cases) || cases.length !== expected.size || new Set(cases.map((item) => item.id)).size !== expected.size || cases.some((item) => !expected.has(item.id))) {
    reject("C019_REFINEMENT_ISOLATION", "requirements-refiner eval catalog is incomplete or contains duplicate cases");
  }
  if (AUXILIARY_WORKFLOW_SKILLS.includes("stnl-requirements-refiner")) {
    reject("C019_REFINEMENT_ISOLATION", "requirements refiner must remain pre-SPEC and outside execution-authority auxiliary workflows");
  }
  const publicText = realFiles(skill)
    .filter((file) => /\.(?:md|json|yaml)$/u.test(file))
    .map((file) => read(file))
    .join("\n");
  for (const marker of ["BLOCKED", "READY_FOR_SPEC", "READY_FOR_ROADMAP", "resolved", "bypassed", "rejected", "inconclusive"]) {
    if (!publicText.includes(marker)) reject("C019_REFINEMENT_ISOLATION", `requirements-refiner public contract omits ${marker}`);
  }
}

function parseArguments(argv) {
  if (argv.length < 3) throw new InfrastructureError("usage: check-contracts.mjs <launchers|validation-runner|subagents|validation-environment-owners|repository> --root PATH [--executor PATH]");
  const scope = argv[0];
  if (!["launchers", "validation-runner", "subagents", "validation-environment-owners", "repository"].includes(scope)) throw new InfrastructureError(`unknown scope: ${scope}`);
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
    else if (scope === "validation-environment-owners") checkValidationEnvironmentOwners(root);
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
