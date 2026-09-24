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

const checkSchemas = {
  EXECUTE_SLICE: [
    "{",
    '  "status": "TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",',
    '  "automaticCheckRound": "1/3 | 2/3 | 3/3",',
    '  "head": "<semantic value>",',
    '  "discoverySources": "<semantic value>",',
    '  "discoveryActions": "<semantic value>",',
    '  "verificationTypesConsidered": "<semantic value>",',
    '  "nonApplicabilityRationale": "<semantic value>",',
    '  "noVerificationCommandConfirmation": "<semantic value>",',
    '  "commands": [{"command": "<full command>", "exit": 0}],',
    '  "resultOfEachCommandAndExitCode": "<semantic value>",',
    '  "selectedChecks": "<semantic value>",',
    '  "selectionRationale": "<semantic value>",',
    '  "coverage": "<semantic value>",',
    '  "failures": "<semantic value>",',
    '  "priorRoundFailure": "<semantic value>",',
    '  "correctionApplied": "<semantic value>",',
    '  "inSliceRationale": "<semantic value>",',
    '  "evidenceOrFailureSummary": "<semantic value>",',
    '  "affectedFilesOrBehaviors": "<semantic value>",',
    '  "blockers": "<semantic value>",',
    '  "unexpectedWorkspaceEffects": "<semantic value>",',
    '  "persistenceSummary": "<semantic value>"',
    "}",
  ],
  APPLY_FINDINGS: [
    "{",
    '  "status": "TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED",',
    '  "automaticCheckRound": "1/3 | 2/3 | 3/3",',
    '  "findingsCycle": "<semantic value>",',
    '  "head": "<semantic value>",',
    '  "discoverySources": "<semantic value>",',
    '  "discoveryActions": "<semantic value>",',
    '  "verificationTypesConsidered": "<semantic value>",',
    '  "nonApplicabilityRationale": "<semantic value>",',
    '  "noVerificationCommandConfirmation": "<semantic value>",',
    '  "commands": [{"command": "<full command>", "exit": 0}],',
    '  "resultOfEachCommandAndExitCode": "<semantic value>",',
    '  "selectedChecks": "<semantic value>",',
    '  "selectionRationale": "<semantic value>",',
    '  "coverage": "<semantic value>",',
    '  "findingsVerified": "<semantic value>",',
    '  "correctionsCovered": "<semantic value>",',
    '  "regressionsSelected": "<semantic value>",',
    '  "unsupportedActiveFindings": "<semantic value>",',
    '  "failures": "<semantic value>",',
    '  "evidenceOrFailureSummary": "<semantic value>",',
    '  "affectedFilesOrBehaviors": "<semantic value>",',
    '  "blockers": "<semantic value>",',
    '  "unexpectedWorkspaceEffects": "<semantic value>",',
    '  "persistenceSummary": "<semantic value>"',
    "}",
  ],
  VALIDATE_SLICE: [
    "{",
    '  "status": "PASS | NEEDS_FIX | BLOCKED",',
    '  "head": "<semantic value>",',
    '  "commands": [{"command": "<full command>", "exit": 0}],',
    '  "evidence": "<semantic value>",',
    '  "findingReferences": "<semantic value>",',
    '  "findingDispositions": "<semantic value>",',
    '  "blockers": "<semantic value>",',
    '  "unexpectedWorkspaceEffects": "<semantic value>",',
    '  "persistenceSummary": "<semantic value>"',
    "}",
  ],
};

function extractSchema(contract, operation) {
  const match = new RegExp(`## Schema ${operation}\\n\\n\\x60\\x60\\x60(?:text|json)\\n([\\s\\S]*?)\\x60\\x60\\x60`, "u").exec(contract);
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
    model: "gpt-5.6-luna",
    model_reasoning_effort: "medium",
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
    model: "claude-sonnet-5",
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
  requirePattern(contract, /`EXECUTE_SLICE` (?:and|e) `APPLY_FINDINGS`[\s\S]{0,180}rodada automática atual como `1\/3`, `2\/3` ou `3\/3`/u, "R004_OPERATION_SCOPE", "runner lacks the exact three-round input set");
  forbidPattern(contract, /(?:1\/4|2\/4|3\/4|4\/4)/u, "R004_OPERATION_SCOPE", "runner permits a fourth automatic round");
  requirePattern(contract, /conclusões do contexto principal como não verificadas/iu, "R014_INDEPENDENCE", "runner does not independently verify main-context claims");
  requirePattern(contract, /Leia somente o escopo necessário/iu, "R014_INDEPENDENCE", "runner read scope is not bounded");
  requirePattern(contract, /Não confie apenas em checkboxes ou em resultados anteriores/iu, "R014_INDEPENDENCE", "runner can trust historical claims without verification");
  requirePattern(contract, /`OFFICIAL_EXECUTION_PREFLIGHT`[\s\S]{0,300}official execution validator\/preflight[\s\S]{0,320}mesmo `SPEC_PATH`, operação e slice/iu, "R019_REQUIREMENTS_AUTHORITY", "runner does not consume the launcher-owned official execution authority result");
  requirePattern(contract, /`OFFICIAL_EXECUTION_PREFLIGHT`[\s\S]{0,260}Não invoque nem reconstrua esse comando no modelo[\s\S]{0,280}campo exato `authority=sha256:<64hex>`[\s\S]{0,240}`Requirements authority`[\s\S]{0,220}artifacts selecionados/iu, "R019_REQUIREMENTS_AUTHORITY", "runner still reconstructs the mechanical official preflight invocation");
  requirePattern(contract, /authority=sha256:<64hex>[\s\S]{0,360}`Requirements authority` recebida no payload[\s\S]{0,240}artifacts selecionados[\s\S]{0,120}idênticos/iu, "R019_REQUIREMENTS_AUTHORITY", "runner does not compare payload, artifact, and runtime canonical authority");
  requirePattern(contract, /Não calcule Requirements authority[\s\S]{0,180}`shared\/requirements\.md`[\s\S]{0,160}`feature_spec\.md`/iu, "R019_REQUIREMENTS_AUTHORITY", "runner does not forbid raw lifecycle file hashes");
  requirePattern(contract, /Não copie nem reimplemente `computeRequirementsAuthority`[\s\S]{0,320}retorne `BLOCKED`[\s\S]{0,120}Não use fallback ad hoc/iu, "R019_REQUIREMENTS_AUTHORITY", "runner authority failure does not fail closed");
  forbidPattern(contract, /(?:^|\n)(?:Calcule|Compute)[^\n]{0,120}(?:shared\/requirements\.md|feature_spec\.md)[^\n]{0,120}(?:Requirements authority|requirements authority)/iu, "R019_REQUIREMENTS_AUTHORITY", "runner reintroduces a raw-file authority algorithm");
  requirePattern(contract, /Antes de qualquer verification command ou status de check auxiliar[\s\S]{0,260}`OFFICIAL_EXECUTION_PREFLIGHT`[\s\S]{0,260}igualdade entre preflight, payload e artifact[\s\S]{0,260}Nunca calcule, compare ou use SHA[\s\S]{0,220}raw digest não é authority e não pode bloquear/iu, "R022_AUTHORITY_IDENTITY", "runner may compare non-canonical raw requirements hashes");

  const execute = /# EXECUTE_SLICE\n([\s\S]*?)# APPLY_FINDINGS\n/u.exec(contract)?.[1] ?? "";
  const findings = /# APPLY_FINDINGS\n([\s\S]*?)# VALIDATE_SLICE\n/u.exec(contract)?.[1] ?? "";
  requirePattern(contract, /Antes de retornar qualquer status[\s\S]{0,280}Tested state[\s\S]{0,260}path\.relative\(dirname\(tasks\/slice-NN\.md\), target\)[\s\S]{0,300}(?:rejeite|reject)[\s\S]{0,220}(?:nunca rebase|never rebase)/iu, "R021_PATH_BASIS", "runner does not fail closed on non-task-relative Tested state paths");
  requirePattern(contract, /Depois de derivar cada claim task-relative[\s\S]{0,260}path\.resolve\(dirname\(taskArtifact\), claim\)[\s\S]{0,220}compare por `realpath`[\s\S]{0,260}não emita `TESTS_PASS`[\s\S]{0,180}target/iu, "R023_PHYSICAL_PATH_IDENTITY", "runner does not verify task-relative claims against the physical target");
  requirePattern(contract, /Antes de emitir qualquer status[\s\S]{0,260}digest file-backed[\s\S]{0,220}formato exato `sha256:`[\s\S]{0,160}64 caracteres hexadecimais minúsculos[\s\S]{0,260}retorne `BLOCKED`[\s\S]{0,160}nunca emita `PASS`/iu, "R024_DIGEST_FORMAT", "runner may emit a status with a truncated or malformed digest");
  requirePattern(contract, /Every file-backed Tested state and formal-manifest tuple MUST use the literal `sha256:` separator; `sha256=` is malformed output[\s\S]{0,120}return `BLOCKED`, never `PASS`/u, "R025_DIGEST_PREFIX", "runner does not reject the sha256 equals-sign delimiter");
  requirePattern(contract, /The operation payload MUST include an absolute `RUNNER_EVIDENCE_SERIALIZER` path[\s\S]*?--execution-bundle --operation <requested-operation> --workspace <managed workspace> --task-artifact <candidateTaskArtifact> --semantic-response-file <absolute-temp-file>/u, "R030_DETERMINISTIC_EVIDENCE_SERIALIZATION", "runner does not require candidate-based deterministic execution evidence");
  requirePattern(contract, /The deterministic producer rejects unknown or missing keys[\s\S]{0,800}path-relative serialization, ordering, labels, delimiters, hashes/u, "R030_DETERMINISTIC_EVIDENCE_SERIALIZATION", "runner leaves recurring evidence serialization to the model");
  requirePattern(contract, /# Canonical response gate\nField shape is strict at the JSON boundary:[\s\S]{0,500}payload is one raw JSON object[\s\S]{0,700}Before returning any result for `EXECUTE_SLICE`, `APPLY_FINDINGS`, or `VALIDATE_SLICE`, emit exactly the machine-key JSON schema (?:below|for that operation)[\s\S]{0,700}status: "BLOCKED"[\s\S]{0,300}never return a prose summary/u, "R026_OUTPUT_GATE", "runner lacks a byte-for-byte canonical semantic response gate");
  forbidPattern(contract, /^Retorne somente `PASS`, `NEEDS_FIX` ou `BLOCKED`\.[\s\S]{0,500}Em `Findings:`/mu, "R026_OUTPUT_GATE", "validation contract reintroduces a narrative output shape alongside the JSON gate");
  forbidPattern(contract, /(?:^|\n)Em `Findings:`, forneça uma disposição/iu, "R026_OUTPUT_GATE", "validation findings are not constrained to the semantic JSON field");
  requirePattern(contract, /The JSON `commands` form is exact:[\s\S]{0,360}each item MUST be an object containing only `command`[\s\S]{0,260}`exit` \(integer\)[\s\S]{0,300}Unknown keys, translated labels, nested scalar values, omitted keys, or malformed commands are rejected as `BLOCKED`/u, "R027_TUPLE_GRAMMAR", "runner does not state the exact semantic command tuple grammar");
  requirePattern(contract, /The machine-key schema is fixed\.[\s\S]{0,1200}For `APPLY_FINDINGS`, insert `findingsCycle` after `automaticCheckRound`[\s\S]{0,700}The main producer adds state-derived and launcher-owned mechanical fields/u, "R028_FIELD_SEQUENCE", "runner does not require the literal semantic field sequence at the final response gate");
  requirePattern(contract, /Field shape is strict at the JSON boundary:[\s\S]{0,500}every semantic property except `commands` is one scalar string[\s\S]{0,300}`commands` is an array of objects with exactly `command` and integer `exit`[\s\S]{0,300}payload is one raw JSON object/u, "R029_FIELD_SHAPE", "runner does not require scalar semantic fields outside Commands");
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
  requirePattern(contract, /Em `TESTS_PASS`[^\n]{0,260}`Tested scope`[^\n]{0,160}`Verification types considered`[^\n]{0,160}`Selected checks`[^\n]{0,160}`Coverage`[^\n]{0,120}(?:nunca podem ser exact `none`|must not be exact `none`)/iu, "R006_VERDICTS", "TESTS_PASS permits none in an objective summary field");
  requirePattern(contract, /`TESTS_FAIL` exige[^\n]{0,160}(?:comandos que falharam|commands that failed)/iu, "R006_VERDICTS", "TESTS_FAIL lacks command-failure evidence");
  requirePattern(contract, /`BLOCKED` exige[^\n]{0,180}(?:impossibilidade objetiva|objective impossibility)/iu, "R006_VERDICTS", "BLOCKED lacks an objective cause");
  forbidPattern(contract, /(?:NEEDS_FIX|BLOCKED)[\s\S]{0,160}(?:(?<!não )proponha|create|(?<!não )crie) Effective Validation Base/iu, "R006_VERDICTS", "non-PASS verdict creates an effective base");
  requirePattern(contract, /caminhos relativos únicos[\s\S]{0,180}SHA-256[\s\S]{0,100}`REMOVED`/iu, "R008_MANIFEST", "final manifest path/hash/removal semantics are incomplete");
  requirePattern(contract, /Tested state[\s\S]{0,180}(?:manifesto final da slice|manifesto final)[\s\S]{0,220}relativo ao diretório do artefato detalhado(?: final)? `tasks\/slice-NN\.md`/iu, "R008_MANIFEST", "tested-state and manifest path base is ambiguous");
  requirePattern(contract, /Em qualquer operação[\s\S]{0,160}`Tested state`[\s\S]{0,160}task-relative[\s\S]{0,220}`path\.relative\(dirname\(taskArtifact\), target\)`[\s\S]{0,220}nunca use CWD[\s\S]{0,220}candidate root/iu, "R008_MANIFEST", "auxiliary tested-state task-relative derivation is missing or ambiguous");
  requirePattern(contract, /caminho armazenado deve resolver exatamente ao target físico cujo hash foi calculado/iu, "R008_MANIFEST", "tested-state path/hash physical identity is missing");
  requirePattern(contract, /fontes consultadas em `Discovery sources`[\s\S]{0,160}`Discovery actions`/iu, "R007_OUTPUT_SCHEMA", "discovery sources and actions are not distinct");
  requirePattern(contract, /rodadas posteriores file-backed[^\n]{0,180}caminhos de correção[^\n]{0,180}task-relative normalizados[^\n]{0,160}comma-space/iu, "R007_OUTPUT_SCHEMA", "file-backed correction-path persistence grammar is missing");
  requirePattern(contract, /correção fileless[^\n]{0,80}`Correction paths`[^\n]{0,40}exact `none`/iu, "R007_OUTPUT_SCHEMA", "fileless correction paths cannot be exact none");
  requirePattern(contract, /`Findings verified`[^\n]{0,100}subconjunto canônico[^\n]{0,100}`Finding IDs`/iu, "R007_OUTPUT_SCHEMA", "verified findings are not constrained to the target subset");
  requirePattern(contract, /`Unsupported active findings`[^\n]{0,140}exatamente os findings ativos[^\n]{0,180}(?:nunca se sobrepõem|never overlap)/iu, "R007_OUTPUT_SCHEMA", "unsupported active findings are not the exact disjoint remainder");
  requirePattern(contract, /não retorne `PASS` com manifesto vazio, incompleto, duplicado, malformado ou inconsistente/iu, "R008_MANIFEST", "manifest rejection cases are incomplete");
  requirePattern(contract, /fileless[\s\S]{0,300}`Fileless reason`[\s\S]{0,300}(?:não invente|never invent).{0,80}(?:path|caminho|hash)/iu, "R008_MANIFEST", "fileless manifest contract is incomplete");
  requirePattern(contract, /overlap[\s\S]{0,500}regressões[\s\S]{0,300}(?:NEEDS_FIX|BLOCKED)/iu, "R010_OVERLAP", "overlap and regression obligations are incomplete");
  requirePattern(contract, /Para cada overlap[^\n]{0,100}valide o comportamento atual e regressões/iu, "R010_OVERLAP", "overlap behavior/regression validation is missing");
  requirePattern(contract, /primeira tentativa[^\n]{0,40}`initial`[^\n]{0,80}`revalidation`/iu, "R009_VALIDATION_ATTEMPT", "attempt type progression is missing");
  requirePattern(contract, /PASS[^\n]{0,240}manifesto final completo/iu, "R009_VALIDATION_ATTEMPT", "PASS does not require a complete final manifest");
  requirePattern(contract, /campo semântico `findingDispositions`[^\n]{0,180}disposição para cada finding/iu, "R009_VALIDATION_ATTEMPT", "formal validation lacks per-finding disposition");
  requirePattern(contract, /novo finding nasce `active`[^\n]{0,180}tentativa formal estritamente posterior/iu, "R009_VALIDATION_ATTEMPT", "new findings can be disposed at their origin attempt");
  requirePattern(contract, /PASS[^\n]{0,260}nenhuma disposição bloqueante ativa/iu, "R009_VALIDATION_ATTEMPT", "PASS may leave a blocking finding active");
  requirePattern(contract, /Checks nunca emitem[^\n]{0,160}(?:Validation Attempt|Effective Validation Base)/iu, "R015_CHECK_AUTHORITY", "check/formal authority separation is incomplete");
  requirePattern(contract, /Responda somente de forma compacta[^\n]{0,120}sem logs completos/iu, "R011_COMPACT_OUTPUT", "runner compact-output boundary is missing");
  requirePattern(contract, /Em `VALIDATE_SLICE`, `commands` deve reproduzir somente cada verification command[\s\S]{0,280}producer determinístico insere o preflight oficial completo[\s\S]{0,300}`SPEC_PATH` exato[\s\S]{0,160}exit code `0`/iu, "R020_EXACT_COMMANDS", "formal validation producer does not own the exact official preflight command");
  requirePattern(contract, /não abrevie argumentos[^\n]{0,120}`\.\.\.`[^\n]{0,100}`<SPEC_PATH>`[^\n]{0,180}não invente labels/iu, "R020_EXACT_COMMANDS", "formal validation permits abbreviated or invented mechanical commands");
  requirePattern(contract, /Se uma entrada semântica tentar emitir o preflight launcher-owned, retorne `BLOCKED`[^\n]{0,180}não corrija/iu, "R020_EXACT_COMMANDS", "formal validation permits silent preflight repair");
  requirePattern(contract, /nunca o reverta automaticamente/iu, "R005_READ_ONLY", "runner may automatically revert workspace effects");

  const readme = read(readmeFile, "R002_REGISTRY");
  for (const launcher of ["slice-execute-codex.md", "slice-execute-claude.md", "slice-apply-findings-codex.md", "slice-apply-findings-claude.md", "slice-validate-codex.md", "slice-validate-claude.md"]) {
    if (!readme.includes(launcher)) reject("R012_README", `runner README omits launcher: ${launcher}`);
  }
  forbidPattern(readme, /stnl-execution-closer|OPERATION=CLOSE|EXECUTION_(?:APPROVED|BLOCKED)/u, "R012_README", "README retains the removed execution closer contract");
  requirePattern(readme, /não existe fallback/iu, "R012_README", "README fallback boundary is missing");
  requirePattern(readme, /não existe passo manual adicional de testes/iu, "R012_README", "README manual-test-step boundary is missing");
  requirePattern(readme, /no mínimo uma vez e no máximo três vezes/iu, "R012_README", "README bounded automatic-round policy is missing");
  requirePattern(readme, /sem histórico da conversa[\s\S]{0,500}Históricos e logs completos não são encaminhados/iu, "R012_README", "README history/minimum-payload boundary is missing");
  requirePattern(readme, /Falha de inicialização ou transporte[\s\S]{0,300}não consomem rodada `N\/3`/iu, "R012_README", "README transport/round separation is missing");
  requirePattern(readme, /não criam `implementation-check-NN`, `findings-check-NN` ou `attempt-NN`/iu, "R012_README", "README transport/evidence separation is missing");
  requirePattern(readme, /retoma diretamente na delegação[\s\S]{0,240}não reinicia identificadores/iu, "R012_README", "README initialization-resume semantics are missing");
  requirePattern(readme, /terceira falha entra em `IMPLEMENTATION_RETRY_EXHAUSTED` ou `FINDINGS_RETRY_EXHAUSTED`[\s\S]{0,180}`VALIDATE_SLICE` é a única próxima operação/iu, "R012_README", "README third-failure recovery is missing");
  requirePattern(readme, /última slice aberta[\s\S]{0,320}cobertura global[\s\S]{0,180}cross-slice[\s\S]{0,180}`BLOCKED`[\s\S]{0,80}`REPLAN`/iu, "R017_TERMINAL_VALIDATION", "README terminal semantic validation is missing");
  requirePattern(readme, /`COMPLETE`[\s\S]{0,260}runtime[\s\S]{0,260}ownership final[\s\S]{0,180}drift[\s\S]{0,180}`REPLAN`/iu, "R018_TERMINAL_INTEGRITY", "README terminal deterministic inspection is missing");
  requirePattern(readme, /fontes em `Discovery sources`, métodos em `Discovery actions`/iu, "R007_OUTPUT_SCHEMA", "README discovery labels are not canonical");
  forbidPattern(readme, /`Check discovery (?:sources|actions)`/iu, "R007_OUTPUT_SCHEMA", "README authorizes historical discovery labels");
}

function checkScout(root) {
  const codexFile = path.join(root, "codex/.codex/agents/stnl_spec_context_scout.toml");
  const claudeFile = path.join(root, "claude-code/.claude/agents/stnl-spec-context-scout.md");
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
    "README.md",
    "codex/.codex/agents/stnl_validation_runner.toml",
    "codex/.codex/agents/stnl_spec_context_scout.toml",
    "codex/package.json",
    "codex/package-lock.json",
    "codex/runtime/isolated-home.mjs",
    "codex/runtime/runner-broker.mjs",
    "codex/runtime/sdk-transport.mjs",
    "codex/runtime/validation-runner.mjs",
    "claude-code/.claude/agents/stnl-validation-runner.md",
    "claude-code/.claude/agents/stnl-spec-context-scout.md",
  ]);
  const actual = new Set(realFiles(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/")));
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) reject("S002_REGISTRY", `subagent registry mismatch; actual=${JSON.stringify([...actual].sort())}`);
  checkRunner(root);
  checkScout(root);
}

const launcherSpecs = {
  "spec-init": ["stnl-spec-lifecycle-manager", "MODE", "INIT", ["SPEC_PATH", "REQUIREMENTS_SOURCE"]],
  "spec-resume": ["stnl-spec-lifecycle-manager", "MODE", "RESUME", ["SPEC_PATH", "NEW_INFORMATION"]],
  "spec-readiness": ["stnl-spec-lifecycle-manager", "MODE", "READINESS", ["SPEC_PATH", "READINESS_SCOPE", "READINESS_FOCUS"]],
  "spec-close": ["stnl-spec-lifecycle-manager", "MODE", "CLOSE", ["SPEC_PATH"]],
  "spec-test-runbook": ["stnl-spec-test-runbook", "OPERATION", "GENERATE_RUNBOOK", ["SPEC_PATH", "RUNBOOK_SCOPE", "RUNBOOK_SELECTION", "RUNBOOK_OPTIONS"]],
  "spec-roadmap-init": ["stnl-spec-roadmap", "OPERATION", "INIT", ["PROJECT_ROOT", "ROADMAP_PATH", "ROADMAP_SOURCE"]],
  "spec-roadmap-reconcile": ["stnl-spec-roadmap", "OPERATION", "RECONCILE", ["PROJECT_ROOT", "ROADMAP_PATH", "NEW_INFORMATION"]],
  "execution-plan": ["stnl-execution-planner", "OPERATION", "PLAN", ["SPEC_PATH"]],
  "execution-replan": ["stnl-execution-planner", "OPERATION", "REPLAN", ["SPEC_PATH", "REPLAN_REASON"]],
  "execution-plan-review": ["stnl-plan-reviewer", "OPERATION", "REVIEW_PLAN", ["SPEC_PATH"]],
  "execution-tasks": ["stnl-task-materializer", "OPERATION", "MATERIALIZE_TASKS", ["SPEC_PATH"]],
  "execution-tasks-review": ["stnl-task-reviewer", "OPERATION", "REVIEW_TASKS", ["SPEC_PATH"]],
  "slice-execute-codex": ["stnl-slice-executor", "OPERATION", "EXECUTE_SLICE", ["SPEC_PATH", "SLICE"]],
  "slice-execute-claude": ["stnl-slice-executor", "OPERATION", "EXECUTE_SLICE", ["SPEC_PATH", "SLICE"]],
  "slice-apply-findings-codex": ["stnl-slice-executor", "OPERATION", "APPLY_FINDINGS", ["SPEC_PATH", "SLICE"]],
  "slice-apply-findings-claude": ["stnl-slice-executor", "OPERATION", "APPLY_FINDINGS", ["SPEC_PATH", "SLICE"]],
  "slice-validate-codex": ["stnl-slice-quality-manager", "OPERATION", "VALIDATE_SLICE", ["SPEC_PATH", "SLICE"]],
  "slice-validate-claude": ["stnl-slice-quality-manager", "OPERATION", "VALIDATE_SLICE", ["SPEC_PATH", "SLICE"]],
};

function parseLauncher(file, spec) {
  const text = read(file, "L001_REGISTRY");
  const expected = [
    `Use ` + "`" + `${spec[0]}` + "`" + `.`,
    `${spec[1]}=${spec[2]}`,
    ...spec[3].map((name) => `${name}={{${name}}}`),
    "",
    "Contexto adicional (opcional):",
    "",
  ].join("\n");
  if (text !== expected) reject("L004_INPUTS", `${file}: launcher must contain only the registered skill, operation, parameters, and optional context`);
  if (/__[^_\s]+__|BENCHMARK_SEQUENCE|MANAGED_WORKSPACE|CANDIDATE_EXECUTION_ROOT|runtime\/|broker|serializer|publisher/iu.test(text)) {
    reject("L010_MECHANICS", `${file}: internal mechanics leaked into a human launcher`);
  }
  return text;
}

function checkLaunchers(root) {
  const actual = Object.fromEntries(fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== ".DS_Store" && !entry.name.startsWith("._"))
    .map((entry) => [entry.name.slice(0, -3), path.join(root, entry.name)]));
  if (!keysEqual(actual, launcherSpecs)) reject("L001_REGISTRY", `launcher registry mismatch; actual=${JSON.stringify(Object.keys(actual).sort())}`);
  for (const [name, spec] of Object.entries(launcherSpecs)) parseLauncher(actual[name], spec);
  for (const operation of ["execute", "apply-findings", "validate"]) {
    const codex = read(actual[`slice-${operation}-codex`]);
    const claude = read(actual[`slice-${operation}-claude`]);
    if (codex !== claude) reject("L018_PLATFORM_EQUIVALENCE", `${operation}: human launchers diverge across platforms`);
  }
}

function checkRepository(root) {
  for (const relative of ["targets", "agents/base"]) {
    if (fs.existsSync(path.join(root, relative))) reject("C019_REMOVED_ROOTS", `removed repository root was recreated: ${relative}`);
  }
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
  for (const token of ["stnl-spec-execution-manager", "stnl-execution-closer", "OPERATION=CLOSE", "EXECUTION_APPROVED", "EXECUTION_BLOCKED", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "EXECUTE_SLICES", "RUN_TESTS", "RETRY_TESTS", "FIX_TESTS", "TEST_SLICE", "TEST_FINDINGS", "VALIDATE_IMPLEMENTATION"]) {
    if (allExecutionText.includes(token)) reject("C009_REMOVED_TOKENS", `removed execution token remains: ${token}`);
  }
  const plannerContract = ["SKILL.md", "templates/plan.template.md", "templates/slice-plan.template.md"].map((relative) => read(path.join(workflowRoot, "stnl-execution-planner", relative))).join("\n");
  const globalPlanTemplate = read(path.join(workflowRoot, "stnl-execution-planner/templates/plan.template.md"));
  const detailedPlanTemplate = read(path.join(workflowRoot, "stnl-execution-planner/templates/slice-plan.template.md"));
  if (!globalPlanTemplate.includes("Model-selected physical target (repository-relative before serialization): `<repository-relative physical target>`; <optional conceptual area> (plain-text description)")) reject("C005_PATH_CARRIERS", "global Expected areas template must separate its semantic physical target from plain-text description");
  if (!detailedPlanTemplate.includes("Implementation filesystem path (outside generated execution artifacts): `<artifact-relative path>` — <optional contract, subsystem, test area, or explanation> (plain-text description)")) reject("C005_PATH_CARRIERS", "detailed Likely Areas template must separate its implementation path from plain-text description");
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
    if (!path.basename(file).startsWith("spec-roadmap-") && /stnl-spec-roadmap|OPERATION=(?:INIT|RECONCILE)/u.test(text)) reject("C018_ROADMAP_ISOLATION", `implicit path invokes roadmap operation: ${file}`);
  }

  checkLifecycleStatic(root);
  const executionSkills = [...EXECUTION_OPERATION_SKILLS];
  for (const runtime of ["execution-state.mjs", "validate-execution-state.mjs"]) {
    const files = executionSkills.map((name) => path.join(workflowRoot, name, "runtime", runtime));
    for (const file of files) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) reject("C006_DISTRIBUTION", `execution skill is missing shared runtime: ${file}`);
    const authority = fs.readFileSync(files[0]);
    for (const file of files.slice(1)) if (!authority.equals(fs.readFileSync(file))) reject("C006_DISTRIBUTION", `shared runtime copies differ: ${runtime}`);
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
  for (const relative of ["scripts/validate.sh", "scripts/smoke-structure.sh", "scripts/test-launcher-contract.sh", "scripts/test-validation-runner-contract.sh"]) {
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
