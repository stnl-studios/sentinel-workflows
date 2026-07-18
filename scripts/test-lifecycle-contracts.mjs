#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = path.join(ROOT, "skills", "stnl-spec-lifecycle-manager");
const RUNTIME_ROOT = path.join(SKILL_ROOT, "runtime");
const TEMPLATE_ROOT = path.join(SKILL_ROOT, "templates");
const CASES_PATH = path.join(SKILL_ROOT, "evals", "cases.json");
const CONTRACT_CASES_PATH = path.join(SKILL_ROOT, "evals", "contract-cases.json");

const {
  ACTIVE_SECTIONS,
  CATEGORIES,
  ValidationError,
  resumeWorkspaceIdentity,
  validateCloseTransition,
  validateInitTransition,
  validateReadinessTransition,
  validateResumeTransition,
  validateWorkspace,
  workspaceSnapshot,
} = await import(pathToFileURL(path.join(RUNTIME_ROOT, "lib", "lifecycle.mjs")).href);
const {
  createReadinessAttestation,
  validateReadinessAttestation,
  workspaceAuthoritySnapshotSha256,
} = await import(pathToFileURL(path.join(RUNTIME_ROOT, "lib", "readiness.mjs")).href);
const { buildClosedCandidate, renderClosedFeature } = await import(
  pathToFileURL(path.join(RUNTIME_ROOT, "lib", "closed-spec.mjs")).href
);

const CATALOG = readJson(CASES_PATH);
const CONTRACT_CATALOG = readJson(CONTRACT_CASES_PATH);
const CATEGORY_BY_KEY = new Map(CATEGORIES.map((category) => [category.key, category]));

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function replaceInFile(file, before, after) {
  const source = readFileSync(file, "utf8");
  assert.ok(source.includes(before), `fixture replacement source missing in ${file}: ${JSON.stringify(before)}`);
  write(file, source.replace(before, after));
}

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function templateHeader(name, status) {
  const text = readFileSync(path.join(TEMPLATE_ROOT, name), "utf8");
  const match = text.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?```\n\n/u);
  assert.ok(match, `template header is malformed: ${name}`);
  let replacements = 0;
  const header = match[0].replace(/^status: \S+$/mu, () => {
    replacements += 1;
    return `status: ${status}`;
  });
  assert.equal(replacements, 1, `template header status is missing: ${name}`);
  return header;
}

function renderFeature(status, artifactKeys, blockingQuestions, requirementIds = undefined) {
  const paths = new Map(CATEGORIES.map((category) => [category.key, `shared/${category.filename}`]));
  const artifactLines = artifactKeys.map((key) => `  ${key}: ${paths.get(key)}`).join("\n");
  const artifactBlock = artifactLines ? `artifacts:\n${artifactLines}` : "artifacts: {}";
  const indexedRequirements = requirementIds ?? (artifactKeys.includes("requirements") ? ["R-001"] : []);
  const requirementsIndex = indexedRequirements.length
    ? indexedRequirements.map((identifier) => `- ${identifier}`).join("\n")
    : "- Not established.";
  return `${templateHeader("feature_spec.template.md", status)}# Fixture Feature - Feature SPEC

## Objective

Provide deterministic invitation expiration behavior.

## Context

### Facts

- Invitations already contain an UTC expiration timestamp.

### Hypotheses

- None identified.

## Scope

- Reject acceptance after the stored expiration timestamp.

## Out of Scope

- Changing invitation delivery channels.

## Requirements

${requirementsIndex}

## Business Rules

- The service clock is the time authority.

## Relevant Contracts

- \`docs/core/CONTRACTS.md §5\` defines the HTTP error envelope.

## Canonical Artifact Index

\`\`\`yaml
${artifactBlock}
\`\`\`

## Blockers

\`\`\`yaml
blocking_questions: [${blockingQuestions.join(", ")}]
documentary_gaps: []
\`\`\`

## Selective Reading

1. Read this header and artifact index.
2. Map the requested ID to one category file.
3. Read the exact item through the next \`###\` heading or EOF.
4. Follow only necessary structural metadata links.
`;
}

function requirementItem({
  identifier = "R-001",
  status = "in_scope",
  coverageJustification = undefined,
} = {}) {
  const justification = coverageJustification === undefined
    ? ""
    : `\n- coverage_justification: ${coverageJustification}`;
  return `### ${identifier} — Expired invitation is rejected

- status: ${status}${justification}

An invitation past \`expires_at\` according to the service UTC clock is rejected without creating participation.
`;
}

function acceptanceItem({
  verifies = ["R-001"],
  references = true,
  blocked = false,
  narrative = undefined,
  status = "active",
  identifier = "AC-001",
} = {}) {
  const blockedLine = blocked ? "- blocked_by: [Q-001]\n" : "";
  const referenceLine = references ? "- references: [D-001, C-001, RK-001]\n" : "";
  const body = narrative ?? "Ao receber um convite cujo `expires_at` já passou segundo o relógio UTC do serviço, a API rejeita a aceitação com o envelope público de convite expirado e não cria participação.";
  return `### ${identifier} — Expired invitation is rejected

- status: ${status}
- verifies: [${verifies.join(", ")}]
${blockedLine}${referenceLine}
${body} The qualified external origin \`initial-scaffold/D-011\` is narrative only.
`;
}

function decisionItem() {
  return `### D-001 — Service clock is authoritative

- status: accepted
- references: [C-001]

#### Contexto

Client clocks can diverge and cannot produce a consistent expiration result.

#### Decisão

The service compares \`expires_at\` with its own UTC clock.

#### Impacto

All clients observe one deterministic expiration decision.
`;
}

function simpleDecisionItem() {
  return `### D-001 — Service clock is authoritative

- status: accepted

#### Contexto

Client clocks can diverge across invitation acceptance attempts.

#### Decisão

The service clock is the single UTC time authority.

#### Impacto

Invitation expiration is deterministic for every client.
`;
}

function constraintItem(identifier = "C-001") {
  return `### ${identifier} — Public error envelope remains stable

- status: active
- references: [D-001]

#### Restrição

Expired invitations use the existing public HTTP error envelope.

#### Razão

Clients already depend on that response contract.
`;
}

function riskItem() {
  return `### RK-001 — Clock drift near expiration boundary

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Clock drift between service nodes can change the result near the expiration boundary.

#### Mitigação

Synchronize nodes, monitor drift, and retain the risk as active while it remains material.
`;
}

function questionItem(status, classification = "blocking") {
  const metadata = status === "open"
    ? `- status: open\n- classification: ${classification}${classification === "blocking" ? "\n- blocks: [AC-001]" : ""}`
    : `- status: resolved\n- classification: ${classification}\n- resolved_by: decision\n- linked_decision: D-001`;
  const resolution = status === "open"
    ? "Pendente."
    : "D-001 explicitly establishes the service UTC clock as authority.";
  return `### Q-001 — Which clock determines expiration

${metadata}

#### Pergunta

Which clock determines whether an invitation is expired?

#### Por que importa

The answer changes the result observed by AC-001.

#### Resolução

${resolution}
`;
}

function sharedDocument(templateName, status, rootHeading, item) {
  return `${templateHeader(templateName, status)}# ${rootHeading}\n\n${item}`;
}

function writeFullWorkspace(root, status) {
  const blocked = status === "blocked";
  const artifactKeys = CATEGORIES.map((category) => category.key);
  write(path.join(root, "feature_spec.md"), renderFeature(status, artifactKeys, blocked ? ["Q-001"] : []));
  write(path.join(root, "shared", "requirements.md"), sharedDocument(
    "shared-requirements.template.md", "ready", "Requirements", requirementItem(),
  ));
  write(path.join(root, "shared", "acceptance-criteria.md"), sharedDocument(
    "shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", acceptanceItem({ blocked }),
  ));
  write(path.join(root, "shared", "decisions.md"), sharedDocument(
    "shared-decisions.template.md", "ready", "Decisions", decisionItem(),
  ));
  write(path.join(root, "shared", "constraints.md"), sharedDocument(
    "shared-constraints.template.md", "ready", "Constraints", constraintItem(),
  ));
  write(path.join(root, "shared", "risks.md"), sharedDocument(
    "shared-risks.template.md", "ready", "Risks", riskItem(),
  ));
  write(path.join(root, "shared", "questions.md"), sharedDocument(
    "shared-questions.template.md",
    blocked ? "blocked" : "ready",
    "Questions",
    questionItem(blocked ? "open" : "resolved"),
  ));
}

function writeDecisionlessBlocked(root) {
  write(path.join(root, "feature_spec.md"), renderFeature(
    "blocked", ["requirements", "acceptance_criteria", "questions"], ["Q-001"],
  ));
  write(path.join(root, "shared", "requirements.md"), sharedDocument(
    "shared-requirements.template.md", "ready", "Requirements", requirementItem(),
  ));
  write(path.join(root, "shared", "acceptance-criteria.md"), sharedDocument(
    "shared-acceptance-criteria.template.md",
    "ready",
    "Acceptance Criteria",
    acceptanceItem({ references: false, blocked: true }),
  ));
  write(path.join(root, "shared", "questions.md"), sharedDocument(
    "shared-questions.template.md", "blocked", "Questions", questionItem("open"),
  ));
}

function instantiateTemplate(name, status) {
  let text = readFileSync(path.join(TEMPLATE_ROOT, name), "utf8");
  let replacements = 0;
  text = text.replace(/^status: \S+$/mu, () => {
    replacements += 1;
    return `status: ${status}`;
  });
  assert.equal(replacements, 1, `template status is missing: ${name}`);
  const values = new Map([
    ["{{FEATURE_NAME}}", "Isolated Template Feature"],
    ["{{OBJECTIVE}}", "Validate isolated template materialization."],
    ["{{ITEM_TITLE}}", "Isolated template item"],
    ["{{CONTENT}}", "Concrete durable fixture content with enough structural detail for validation."],
  ]);
  for (const [placeholder, value] of values) text = text.replaceAll(placeholder, value);
  return text;
}

function renderIsolatedFeature(categoryKey) {
  if (categoryKey === "acceptance_criteria") {
    return renderFeature("draft", ["requirements", "acceptance_criteria"], [], ["R-001"]);
  }
  if (categoryKey === "questions") return renderFeature("blocked", ["questions"], ["Q-001"], []);
  return renderFeature(
    "draft",
    [categoryKey],
    [],
    categoryKey === "requirements" ? ["R-001"] : [],
  );
}

function writeIsolatedTemplateWorkspace(root, categoryKey) {
  const category = CATEGORY_BY_KEY.get(categoryKey);
  assert.ok(category, `unknown category ${categoryKey}`);
  write(path.join(root, "feature_spec.md"), renderIsolatedFeature(categoryKey));
  if (categoryKey === "acceptance_criteria") {
    write(path.join(root, "shared", "requirements.md"), instantiateTemplate(
      "shared-requirements.template.md", "ready",
    ));
  }
  const templateName = `shared-${category.filename.replace(/\.md$/u, "")}.template.md`;
  write(
    path.join(root, "shared", category.filename),
    instantiateTemplate(templateName, categoryKey === "questions" ? "blocked" : "ready"),
  );
}

function syncRequirementIndex(root) {
  const requirementsFile = path.join(root, "shared", "requirements.md");
  const identifiers = [...readFileSync(requirementsFile, "utf8").matchAll(/^### (R-\d{3}) — /gmu)]
    .map((match) => match[1])
    .sort();
  const rendered = identifiers.length
    ? identifiers.map((identifier) => `- ${identifier}`).join("\n")
    : "- Not established.";
  const feature = path.join(root, "feature_spec.md");
  const text = readFileSync(feature, "utf8");
  const next = text.replace(
    /(## Requirements\n\n)[\s\S]*?(\n\n## Business Rules)/u,
    `$1${rendered}$2`,
  );
  assert.notEqual(next, text, "fixture feature lacks Requirements section boundary");
  write(feature, next);
}

function appendRequirement(root, item) {
  const file = path.join(root, "shared", "requirements.md");
  write(file, `${readFileSync(file, "utf8").trimEnd()}\n\n${item}`);
  syncRequirementIndex(root);
}

function appendSharedItem(root, filename, item) {
  const file = path.join(root, "shared", filename);
  write(file, `${readFileSync(file, "utf8").trimEnd()}\n\n${item}`);
  if (filename === "requirements.md") syncRequirementIndex(root);
}

function removeSharedItem(root, filename, identifier) {
  const file = path.join(root, "shared", filename);
  const source = readFileSync(file, "utf8");
  const expression = new RegExp(
    `^### ${escapeRegExp(identifier)} — [\\s\\S]*?(?=^### |(?![\\s\\S]))`,
    "mu",
  );
  const next = source.replace(expression, "").trimEnd() + "\n";
  assert.notEqual(next, source, `fixture item is missing: ${identifier}`);
  write(file, next);
  if (filename === "requirements.md") syncRequirementIndex(root);
}

function retireSharedItem(
  root,
  filename,
  identifier,
  sourceStatus,
  reason = "The record is no longer applicable, but its canonical identity remains reserved.",
) {
  const file = path.join(root, "shared", filename);
  const source = readFileSync(file, "utf8");
  const expression = new RegExp(
    `(^### ${escapeRegExp(identifier)} — [\\s\\S]*?^- status: )${escapeRegExp(sourceStatus)}$`,
    "mu",
  );
  const next = source.replace(expression, `$1retired\n- retired_reason: ${reason}`);
  assert.notEqual(next, source, `fixture item cannot be retired: ${identifier}`);
  write(file, next);
}

function writeResumeManifest(file, before, {
  featureSections = [],
  existingIds = [],
  newIds = [],
  statusTransitions = [],
  recordStatusTransitions = [],
  mutate = undefined,
} = {}) {
  const workspace = validateWorkspace(before);
  const manifest = {
    schema_version: 1,
    mode: "RESUME",
    workspace_identity: {
      h1: workspace.h1,
      pre_state_sha256: resumeWorkspaceIdentity(before),
    },
    allowed_feature_sections: featureSections,
    allowed_existing_ids: existingIds,
    allowed_new_ids: newIds,
    allowed_status_transitions: statusTransitions.map(([target, from, to]) => ({
      path: target,
      from,
      to,
    })),
    allowed_record_status_transitions: recordStatusTransitions.map(([target, id, from, to]) => ({
      path: target,
      id,
      from,
      to,
    })),
  };
  mutate?.(manifest);
  write(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

function mutateWorkspace(root, fixture) {
  const inert = new Set([
    "ready",
    "blocked",
    "decisionless_blocked",
    "external_reference",
    "active_risk",
    "ready_with_execution",
    "valid_non_heuristic_ac",
    "technical_result_user",
    "technical_promise_result",
    "technical_html",
    "empty_artifact_index",
    "ready_missing_ac_file",
    "ready_no_ac_index",
    "unindexed_ac_file",
    "blocked_without_ac",
    "open_question_reciprocal",
  ]);
  if (inert.has(fixture)) return;
  const acceptance = path.join(root, "shared", "acceptance-criteria.md");
  const questions = path.join(root, "shared", "questions.md");
  if (fixture === "empty_ac") {
    write(acceptance, `${templateHeader("shared-acceptance-criteria.template.md", "ready")}# Acceptance Criteria\n\n`);
  } else if (fixture === "no_active_ac") {
    replaceInFile(acceptance, "- status: active", "- status: superseded");
  } else if (fixture === "only_dropped_ac") {
    replaceInFile(acceptance, "- status: active", "- status: dropped");
  } else if (fixture === "ready_ac_blocked") {
    replaceInFile(acceptance, "- verifies: [R-001]\n", "- verifies: [R-001]\n- blocked_by: [Q-001]\n");
  } else if (fixture === "empty_ac_narrative") {
    const source = readFileSync(acceptance, "utf8");
    write(acceptance, source.replace(/\n\nAo receber[\s\S]*?narrative only\.\n/u, "\n\n\n"));
  } else if (fixture === "placeholder_real") {
    replaceInFile(acceptance, "Ao receber", "{{CONTENT}} Ao receber");
  } else if (fixture === "preamble_before_item") {
    replaceInFile(acceptance, "# Acceptance Criteria\n\n", "# Acceptance Criteria\n\nArbitrary preamble.\n\n");
  } else if (fixture === "notes_after_item") {
    write(acceptance, `${readFileSync(acceptance, "utf8")}\n## Notes\n\nArbitrary notes.\n`);
  } else if (fixture === "wrong_root_heading") {
    replaceInFile(acceptance, "# Acceptance Criteria", "# Criteria");
  } else if (fixture === "multiple_root_headings") {
    replaceInFile(acceptance, "# Acceptance Criteria\n\n", "# Acceptance Criteria\n\n# Acceptance Criteria\n\n");
  } else if (fixture === "unknown_item_section") {
    replaceInFile(
      path.join(root, "shared", "decisions.md"),
      "#### Impacto\n\n",
      "#### Unknown\n\nUnexpected section.\n\n#### Impacto\n\n",
    );
  } else if (fixture === "invalid_h3_heading") {
    replaceInFile(acceptance, "### AC-001 —", "### Criterion —");
  } else if (fixture === "loose_content_after_item") {
    write(acceptance, `${readFileSync(acceptance, "utf8")}\n### Appendix\n\nLoose content.\n`);
  } else if (fixture === "open_question_without_blocks") {
    writeFullWorkspace(root, "blocked");
    replaceInFile(questions, "- blocks: [AC-001]\n", "");
  } else if (fixture === "resolved_question_with_blocks") {
    replaceInFile(questions, "- classification: blocking\n", "- classification: blocking\n- blocks: [AC-001]\n");
  } else if (fixture === "blocked_by_resolved_question") {
    replaceInFile(acceptance, "- verifies: [R-001]\n", "- verifies: [R-001]\n- blocked_by: [Q-001]\n");
  } else if (fixture === "missing_internal") {
    replaceInFile(path.join(root, "shared", "risks.md"), "[C-001, AC-001]", "[C-001, AC-999]");
  } else if (fixture === "divergent_links") {
    writeFullWorkspace(root, "blocked");
    replaceInFile(acceptance, "- blocked_by: [Q-001]\n", "");
  } else if (fixture === "item_yaml") {
    replaceInFile(acceptance, "Ao receber", "```yaml\nstatus: active\n```\n\nAo receber");
  } else if (fixture === "body_id") {
    replaceInFile(acceptance, "Ao receber", "id: AC-001\n\nAo receber");
  } else if (fixture === "duplicate_id") {
    write(acceptance, `${readFileSync(acceptance, "utf8")}\n${acceptanceItem()}`);
  } else if (fixture === "wrong_prefix") {
    replaceInFile(acceptance, "### AC-001 —", "### D-001 —");
  } else if (fixture === "missing_metadata") {
    replaceInFile(acceptance, "- status: active\n", "");
  } else if (fixture === "invalid_status") {
    replaceInFile(path.join(root, "shared", "risks.md"), "- status: active", "- status: open");
  } else if (fixture === "stale_blocking_index") {
    replaceInFile(path.join(root, "feature_spec.md"), "blocking_questions: [Q-001]", "blocking_questions: []");
  } else {
    assert.fail(`unknown fixture mutation: ${fixture}`);
  }
}

function workspaceFixture(root, fixture) {
  if (["blocked", "stale_blocking_index", "open_question_reciprocal"].includes(fixture)) {
    writeFullWorkspace(root, "blocked");
  } else if (fixture === "decisionless_blocked") {
    writeDecisionlessBlocked(root);
  } else if (fixture === "ready_missing_ac_file") {
    writeFullWorkspace(root, "ready");
    unlinkSync(path.join(root, "shared", "acceptance-criteria.md"));
  } else if (fixture === "ready_no_ac_index") {
    write(path.join(root, "feature_spec.md"), renderFeature("ready", ["requirements"], []));
    write(path.join(root, "shared", "requirements.md"), sharedDocument(
      "shared-requirements.template.md", "ready", "Requirements", requirementItem(),
    ));
  } else if (fixture === "empty_artifact_index") {
    write(path.join(root, "feature_spec.md"), renderFeature("draft", [], []));
  } else if (fixture === "blocked_without_ac") {
    write(path.join(root, "feature_spec.md"), renderFeature("blocked", ["questions"], ["Q-001"]));
    const question = questionItem("open").replace("- blocks: [AC-001]", "- blocks: []");
    write(path.join(root, "shared", "questions.md"), sharedDocument(
      "shared-questions.template.md", "blocked", "Questions", question,
    ));
  } else if (fixture === "unindexed_ac_file") {
    write(path.join(root, "feature_spec.md"), renderFeature("draft", [], []));
    write(path.join(root, "shared", "acceptance-criteria.md"), sharedDocument(
      "shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", acceptanceItem(),
    ));
  } else {
    writeFullWorkspace(root, "ready");
  }
  if (fixture === "ready_with_execution") {
    write(path.join(root, "execution", "retained-record.txt"), "external execution state\n");
  } else if (fixture === "technical_result_user") {
    replaceInFile(
      path.join(root, "shared", "acceptance-criteria.md"),
      "Ao receber",
      "O adapter retorna `Repository<Result<User>>` e mantém",
    );
  } else if (fixture === "technical_promise_result") {
    replaceInFile(
      path.join(root, "shared", "acceptance-criteria.md"),
      "Ao receber",
      "Chamadas subsequentes funcionam com `Promise<Result<T>>` e",
    );
  } else if (fixture === "technical_html") {
    replaceInFile(
      path.join(root, "shared", "acceptance-criteria.md"),
      "Ao receber",
      "O resumo mantém a tag `<strong>` renderizada e",
    );
  }
  mutateWorkspace(root, fixture);
}

function renderMetadata(item) {
  const lines = [];
  for (const field of item.category.fields) {
    if (!item.metadata.has(field)) continue;
    const value = item.metadata.get(field);
    lines.push(`- ${field}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`);
  }
  return lines.join("\n");
}

function renderItem(item) {
  return `### ${item.identifier} — ${item.title}\n\n${renderMetadata(item)}\n\n${item.narrative}\n`;
}

function renderClosed(workspace) {
  const byPrefix = new Map(["R", "AC", "D", "C", "RK", "Q"].map((prefix) => [prefix, []]));
  for (const item of workspace.items.values()) byPrefix.get(item.category.prefix).push(item);
  for (const values of byPrefix.values()) values.sort((left, right) => left.identifier.localeCompare(right.identifier));
  const chunks = [
    templateHeader("closed-feature_spec.template.md", "closed"),
    "# Fixture Feature - Feature SPEC\n\n",
    `## Objective\n\n${workspace.sections.get("Objective")}\n\n`,
    `## Context\n\n${workspace.sections.get("Context")}\n\n`,
    `## Final Scope\n\n${workspace.sections.get("Scope")}\n\n`,
    `## Out of Scope\n\n${workspace.sections.get("Out of Scope")}\n\n`,
    "## Requirements\n\n",
    ...byPrefix.get("R").map((item) => `${renderItem(item)}\n`),
    `## Business Rules\n\n${workspace.sections.get("Business Rules")}\n\n`,
  ];
  for (const [heading, prefix] of [
    ["Final Acceptance Criteria", "AC"],
    ["Durable Decisions", "D"],
    ["Relevant Constraints", "C"],
    ["Relevant Risks", "RK"],
  ]) {
    if (!byPrefix.get(prefix).length) continue;
    chunks.push(`## ${heading}\n\n`, ...byPrefix.get(prefix).map((item) => `${renderItem(item)}\n`));
  }
  chunks.push(`## Important Contracts\n\n${workspace.sections.get("Relevant Contracts")}\n\n`);
  if (byPrefix.get("Q").length) {
    chunks.push(
      "## Durable Resolved Questions\n\n",
      ...byPrefix.get("Q").map((item) => `${renderItem(item)}\n`),
    );
  }
  return `${chunks.join("").trimEnd()}\n`;
}

function buildClosePair(base, status) {
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  writeFullWorkspace(before, status);
  write(path.join(before, "execution", "retained-record.txt"), "external execution state\n");
  const source = validateWorkspace(before);
  cpSync(before, after, { recursive: true });
  write(path.join(after, "feature_spec.md"), renderClosed(source));
  rmSync(path.join(after, "shared"), { recursive: true });
  return [before, after];
}

function fileSnapshot(root) {
  const result = new Map();
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const metadata = lstatSync(entry);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        visit(entry);
      } else if (metadata.isFile()) {
        const relative = path.relative(root, entry).split(path.sep).join("/");
        result.set(relative, createHash("sha256").update(readFileSync(entry)).digest("hex"));
      }
    }
  }
  visit(root);
  return result;
}

function mapsEqual(left, right) {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

function changedPaths(before, after) {
  return new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter((entry) => before.get(entry) !== after.get(entry)),
  );
}

function allowed(relative, entries) {
  return entries.some((entry) => relative === entry || (entry.endsWith("/") && relative.startsWith(entry)));
}

function assertAllowedChanges(changes, allowedChanges, caseId) {
  const unexpected = [...changes].filter((entry) => !allowed(entry, allowedChanges)).sort();
  assert.deepEqual(unexpected, [], `${caseId}: unexpected changed paths`);
}

function assertWorkspace(case_, workspace, resultRoot) {
  assert.equal(workspace.status, case_.expected_status, `${case_.id}: wrong status`);
  assert.deepEqual(
    [...workspace.items.keys()].sort(),
    [...case_.expected_ids].sort(),
    `${case_.id}: wrong canonical IDs`,
  );
  for (const [expression, expected] of Object.entries(case_.expected_links)) {
    const [identifier, field] = expression.split(".", 2);
    assert.deepEqual(workspace.items.get(identifier).metadata.get(field), expected, `${case_.id}: ${expression}`);
  }
  for (const relative of case_.expected_files) {
    assert.ok(existsSync(path.join(resultRoot, ...relative.split("/"))), `${case_.id}: missing ${relative}`);
  }
  for (const forbidden of ["plan.md", "tasks.md", "plans", "tasks"]) {
    assert.equal(existsSync(path.join(resultRoot, forbidden)), false, `${case_.id}: operational artifact exists`);
  }
}

function runResumeResolve(case_, base) {
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  writeFullWorkspace(before, "blocked");
  validateWorkspace(before);
  cpSync(before, after, { recursive: true });
  const beforeSnapshot = fileSnapshot(before);
  replaceInFile(path.join(after, "feature_spec.md"), "status: blocked", "status: ready");
  replaceInFile(path.join(after, "feature_spec.md"), "blocking_questions: [Q-001]", "blocking_questions: []");
  write(path.join(after, "shared", "questions.md"), sharedDocument(
    "shared-questions.template.md", "ready", "Questions", questionItem("resolved"),
  ));
  replaceInFile(path.join(after, "shared", "acceptance-criteria.md"), "- blocked_by: [Q-001]\n", "");
  const manifest = writeResumeManifest(path.join(base, "resume-manifest.json"), before, {
    featureSections: ["Blockers"],
    existingIds: ["AC-001", "Q-001"],
    statusTransitions: [
      ["feature_spec.md", "blocked", "ready"],
      ["shared/questions.md", "blocked", "ready"],
    ],
    recordStatusTransitions: [["shared/questions.md", "Q-001", "open", "resolved"]],
  });
  const [, workspace] = validateResumeTransition(before, after, manifest);
  assertAllowedChanges(changedPaths(beforeSnapshot, fileSnapshot(after)), case_.allowed_changes, case_.id);
  return [workspace, after];
}

function runResumeDecision(case_, base) {
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  writeDecisionlessBlocked(before);
  validateWorkspace(before);
  cpSync(before, after, { recursive: true });
  const beforeSnapshot = fileSnapshot(before);
  write(path.join(after, "feature_spec.md"), renderFeature(
    "ready", ["requirements", "acceptance_criteria", "decisions", "questions"], [],
  ));
  const criterion = acceptanceItem({ references: false }).replace(
    "\nAo receber",
    "- references: [D-001]\n\nAo receber",
  );
  write(path.join(after, "shared", "acceptance-criteria.md"), sharedDocument(
    "shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", criterion,
  ));
  write(path.join(after, "shared", "decisions.md"), sharedDocument(
    "shared-decisions.template.md", "ready", "Decisions", simpleDecisionItem(),
  ));
  write(path.join(after, "shared", "questions.md"), sharedDocument(
    "shared-questions.template.md", "ready", "Questions", questionItem("resolved"),
  ));
  const manifest = writeResumeManifest(path.join(base, "resume-manifest.json"), before, {
    featureSections: ["Canonical Artifact Index", "Blockers"],
    existingIds: ["AC-001", "Q-001"],
    newIds: ["D-001"],
    statusTransitions: [
      ["feature_spec.md", "blocked", "ready"],
      ["shared/questions.md", "blocked", "ready"],
    ],
    recordStatusTransitions: [["shared/questions.md", "Q-001", "open", "resolved"]],
  });
  const [, workspace] = validateResumeTransition(before, after, manifest);
  assertAllowedChanges(changedPaths(beforeSnapshot, fileSnapshot(after)), case_.allowed_changes, case_.id);
  return [workspace, after];
}

function runResumeManifestCase(case_, base) {
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  const manifest = path.join(base, "resume-manifest.json");
  const fixture = case_.fixture;
  writeFullWorkspace(before, "ready");
  if (["physical_remove_r002", "type_swap_r002", "retire_and_extend", "retired_reason_tautology"].includes(fixture)) {
    appendRequirement(before, requirementItem({ identifier: "R-002", status: "out_of_scope" }));
  } else if (fixture === "gap_fill_r002") {
    appendRequirement(before, requirementItem({ identifier: "R-003", status: "out_of_scope" }));
  }
  validateWorkspace(before);
  cpSync(before, after, { recursive: true });
  const beforeSnapshot = fileSnapshot(before);
  const options = {};
  if (["authorized_requirement", "unauthorized_requirement"].includes(fixture)) {
    replaceInFile(
      path.join(after, "shared", "requirements.md"),
      "An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.",
      "The service rejects the invitation after authoritative UTC expiration without creating participation.",
    );
    if (fixture === "authorized_requirement") options.existingIds = ["R-001"];
  } else if (["authorized_objective", "unauthorized_objective"].includes(fixture)) {
    replaceInFile(
      path.join(after, "feature_spec.md"),
      "Provide deterministic invitation expiration behavior.",
      "Provide deterministic and auditable invitation expiration behavior.",
    );
    if (fixture === "authorized_objective") options.featureSections = ["Objective"];
  } else if (fixture === "authorized_new_id") {
    appendRequirement(after, requirementItem({ identifier: "R-002", status: "out_of_scope" }));
    options.featureSections = ["Requirements"];
    options.newIds = ["R-002"];
  } else if (fixture === "legacy_removal_authority") {
    options.mutate = (value) => { value.allowed_removed_ids = ["R-002"]; };
  } else if (fixture === "physical_remove_r002") {
    removeSharedItem(after, "requirements.md", "R-002");
    options.featureSections = ["Requirements"];
  } else if (fixture === "gap_fill_r002") {
    appendRequirement(after, requirementItem({ identifier: "R-002", status: "out_of_scope" }));
    options.featureSections = ["Requirements"];
    options.newIds = ["R-002"];
  } else if (fixture === "type_swap_r002") {
    removeSharedItem(after, "requirements.md", "R-002");
    appendSharedItem(after, "constraints.md", constraintItem("C-002"));
    options.featureSections = ["Requirements"];
    options.newIds = ["C-002"];
  } else if (fixture === "retire_and_extend") {
    retireSharedItem(after, "requirements.md", "R-002", "out_of_scope");
    appendRequirement(after, requirementItem({ identifier: "R-003", status: "out_of_scope" }));
    options.featureSections = ["Requirements"];
    options.existingIds = ["R-002"];
    options.newIds = ["R-003"];
    options.recordStatusTransitions = [["shared/requirements.md", "R-002", "out_of_scope", "retired"]];
  } else if (fixture === "retired_reason_tautology") {
    retireSharedItem(after, "requirements.md", "R-002", "out_of_scope", "Retired.");
    options.existingIds = ["R-002"];
    options.recordStatusTransitions = [["shared/requirements.md", "R-002", "out_of_scope", "retired"]];
  } else if (!["missing_manifest", "malformed_manifest", "post_facto_manifest"].includes(fixture)) {
    assert.fail(`unknown RESUME manifest fixture: ${fixture}`);
  }

  let manifestPath = manifest;
  if (fixture === "missing_manifest") {
    manifestPath = null;
  } else if (fixture === "malformed_manifest") {
    write(manifest, "{malformed\n");
  } else if (fixture === "post_facto_manifest") {
    replaceInFile(
      path.join(after, "feature_spec.md"),
      "Provide deterministic invitation expiration behavior.",
      "Provide a post-facto replacement objective.",
    );
    writeResumeManifest(manifest, before, {
      mutate: (value) => { value.workspace_identity.pre_state_sha256 = resumeWorkspaceIdentity(after); },
    });
  } else {
    writeResumeManifest(manifest, before, options);
  }
  const [, workspace] = validateResumeTransition(before, after, manifestPath);
  assertAllowedChanges(changedPaths(beforeSnapshot, fileSnapshot(after)), case_.allowed_changes, case_.id);
  assert.equal(existsSync(path.join(after, "resume-manifest.json")), false, `${case_.id}: manifest persisted`);
  return [workspace, after];
}

function executeCatalogCase(case_, base) {
  if (case_.runner === "template_isolated") {
    const root = path.join(base, "workspace");
    writeIsolatedTemplateWorkspace(root, case_.fixture);
    return [validateWorkspace(root), root];
  }
  if (case_.runner === "resume_resolve") return runResumeResolve(case_, base);
  if (case_.runner === "resume_decision") return runResumeDecision(case_, base);
  if (case_.runner === "resume_manifest") return runResumeManifestCase(case_, base);
  if (["close_valid", "close_loss", "close_execution_mutation", "close_blocked"].includes(case_.runner)) {
    const [before, after] = buildClosePair(base, case_.runner === "close_blocked" ? "blocked" : "ready");
    const beforeSnapshot = fileSnapshot(before);
    if (case_.runner === "close_loss") {
      replaceInFile(
        path.join(after, "feature_spec.md"),
        "All clients observe one deterministic expiration decision.",
        "Clients may observe a changed expiration decision.",
      );
    } else if (case_.runner === "close_execution_mutation") {
      write(path.join(after, "execution", "retained-record.txt"), "mutated external execution state\n");
    }
    const [, workspace] = validateCloseTransition(before, after);
    assertAllowedChanges(changedPaths(beforeSnapshot, fileSnapshot(after)), case_.allowed_changes, case_.id);
    return [workspace, after];
  }
  const root = path.join(base, "workspace");
  workspaceFixture(root, case_.fixture);
  const before = fileSnapshot(root);
  const workspace = validateWorkspace(root);
  assert.equal(mapsEqual(before, fileSnapshot(root)), true, `${case_.id}: validator mutated workspace`);
  return [workspace, root];
}

test("catalog contract: 69 complete, unique executable lifecycle cases", () => {
  assert.equal(CATALOG.length, 69, "the executable lifecycle catalog size changed");
  const required = new Set([
    "id",
    "operation",
    "runner",
    "fixture",
    "input_files",
    "expected_files",
    "allowed_changes",
    "expected_valid",
    "expected_status",
    "expected_ids",
    "expected_links",
    "assertions",
  ]);
  const identifiers = new Set();
  const canonicalModes = new Set(["INIT", "RESUME", "READINESS", "CLOSE"]);
  const runners = new Set([
    "workspace",
    "resume_resolve",
    "resume_decision",
    "resume_manifest",
    "readiness_read_only",
    "close_valid",
    "close_blocked",
    "close_loss",
    "close_execution_mutation",
    "template_isolated",
  ]);
  for (const case_ of CATALOG) {
    const missing = [...required].filter((field) => !Object.hasOwn(case_, field));
    assert.deepEqual(missing, [], `${case_.id ?? "<missing-id>"}: incomplete catalog record`);
    assert.equal(identifiers.has(case_.id), false, `duplicate executable case ID ${case_.id}`);
    identifiers.add(case_.id);
    assert.equal(canonicalModes.has(case_.operation), true, `${case_.id}: legacy or unknown MODE`);
    assert.equal(runners.has(case_.runner), true, `${case_.id}: unknown runner`);
    if (case_.operation === "INIT") {
      const uncovered = case_.expected_files.filter((relative) => !allowed(relative, case_.allowed_changes));
      assert.deepEqual(uncovered, [], `${case_.id}: INIT expected files exceed allowed changes`);
    }
  }
  assert.deepEqual(
    new Set(CATALOG.map((case_) => case_.operation)),
    new Set(["INIT", "RESUME", "READINESS", "CLOSE"]),
    "catalog does not cover all canonical modes",
  );
});

for (const case_ of CATALOG) {
  test(`eval catalog: ${case_.id}`, (t) => {
    const base = temporaryDirectory(t, `stnl-node-${case_.id}-`);
    if (case_.expected_valid) {
      let result;
      assert.doesNotThrow(() => { result = executeCatalogCase(case_, base); });
      const [workspace, resultRoot] = result;
      assertWorkspace(case_, workspace, resultRoot);
      return;
    }
    assert.throws(
      () => executeCatalogCase(case_, base),
      (error) => {
        assert.equal(error instanceof ValidationError, true, `${case_.id}: wrong error category: ${error}`);
        assert.match(error.message, new RegExp(escapeRegExp(case_.expected_error), "u"), `${case_.id}: wrong error`);
        return true;
      },
    );
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("static contract catalog metadata and group coverage", () => {
  assert.equal(CONTRACT_CATALOG.kind, "static_contract_fixtures");
  assert.equal(CONTRACT_CATALOG.model_eval_executed, false);
  assert.equal(typeof CONTRACT_CATALOG.purpose, "string");
  assert.ok(CONTRACT_CATALOG.purpose.length > 0);
  const groups = [
    "triggering",
    "mode_boundaries",
    "readiness",
    "readiness_scope_negative_controls",
    "exploration",
    "scout_scope_negative_controls",
    "security",
    "token_scenarios",
    "interruption",
  ];
  const allCases = groups.flatMap((group) => {
    assert.ok(Array.isArray(CONTRACT_CATALOG[group]), `missing static contract group ${group}`);
    return CONTRACT_CATALOG[group];
  });
  assert.equal(allCases.length, 61, "static contract fixture count changed");
  assert.equal(new Set(allCases.map((case_) => case_.id)).size, allCases.length, "duplicate static contract ID");
});

for (const case_ of CONTRACT_CATALOG.triggering) {
  test(`static triggering contract: ${case_.id}`, () => {
    const canonicalModes = new Set(["INIT", "RESUME", "READINESS", "CLOSE"]);
    if (case_.expected_trigger) {
      assert.equal(canonicalModes.has(case_.expected_mode), true);
      assert.match(case_.request, new RegExp(`MODE=${case_.expected_mode}`, "u"));
    } else {
      assert.equal(case_.expected_mode, null);
      assert.equal([...canonicalModes].some((mode) => case_.request.includes(`MODE=${mode}`)), false);
    }
  });
}

for (const case_ of CONTRACT_CATALOG.mode_boundaries) {
  test(`static mode boundary: ${case_.id}`, () => {
    const canonicalModes = new Set(["INIT", "RESUME", "READINESS", "CLOSE"]);
    const actual = canonicalModes.has(case_.requested_mode) && case_.explicit;
    assert.equal(actual, case_.expected_allowed);
  });
}

for (const case_ of CONTRACT_CATALOG.readiness) {
  test(`static readiness policy: ${case_.id}`, () => {
    assert.equal(new Set(["LOCAL", "GLOBAL"]).has(case_.scope), true);
    let actual = !case_.mutates;
    if (case_.scope === "LOCAL" && case_.may_declare_global_ready) actual = false;
    if (case_.scope === "GLOBAL" && !case_.reads_all_material_authority) actual = false;
    assert.equal(actual, case_.expected_allowed);
  });
}

for (const case_ of CONTRACT_CATALOG.readiness_scope_negative_controls) {
  test(`static readiness scope negative control: ${case_.id}`, () => {
    assert.equal(case_.negative_control, true);
    assert.equal(["LOCAL", "GLOBAL"].includes(case_.value), case_.expected_allowed);
    assert.equal(case_.expected_allowed, false);
  });
}

for (const case_ of CONTRACT_CATALOG.exploration) {
  test(`static exploration contract: ${case_.id}`, () => {
    const escalationSignal = ["candidate_overload", "distributed_conflict", "context_pressure"]
      .some((field) => case_[field]);
    const eligible = !case_.deterministic_evidence_sufficient
      && case_.relevant_gap_remains
      && escalationSignal
      && case_.scouts_already_used === 0;
    assert.equal(eligible, case_.expected_scout_eligible);
    assert.equal(eligible ? 1 : 0, case_.expected_scout_calls);
    assert.ok(case_.expected_scout_calls <= 1);
  });
}

for (const case_ of CONTRACT_CATALOG.scout_scope_negative_controls) {
  test(`static scout scope negative control: ${case_.id}`, () => {
    assert.equal(case_.negative_control, true);
    assert.equal(case_.expected_allowed, false);
    assert.equal(new Set([
      "add_second_evidence_question",
      "expand_allowed_roots",
      "replace_bounded_search_with_repository_survey",
    ]).has(case_.requested_change), true);
  });
}

for (const case_ of CONTRACT_CATALOG.security) {
  test(`static security contract: ${case_.id}`, () => {
    assert.equal(case_.expected_treatment, "data");
    assert.equal(case_.expected_writes, false);
    assert.equal(case_.expected_permission_escalation, false);
    assert.equal(case_.expected_subdelegation, false);
  });
}

for (const case_ of CONTRACT_CATALOG.token_scenarios) {
  test(`static progressive-disclosure contract: ${case_.id}`, () => {
    assert.equal(["INIT", "RESUME", "READINESS", "CLOSE"].includes(case_.operation), true);
    assert.equal(new Set([
      "bootstrap",
      "category_and_dependencies",
      "focused_records",
      "impacted_authority",
      "all_material_authority",
      "all_durable_content",
    ]).has(case_.expected_read_scope), true);
    if (!case_.metrics_available) assert.equal(case_.invent_metrics, false);
  });
}

for (const case_ of CONTRACT_CATALOG.interruption) {
  test(`static interruption policy: ${case_.id}`, () => {
    const published = case_.failure_point === null && case_.candidate_valid;
    assert.equal(published, case_.expected_published_change);
    assert.equal(case_.expected_partial_close, false);
  });
}

function runCli(entrypoint, arguments_, { cwd = ROOT, timeout = 10_000 } = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(RUNTIME_ROOT, entrypoint), ...arguments_],
    { cwd, encoding: "utf8", timeout, windowsHide: true },
  );
  assert.equal(result.error, undefined, `${entrypoint}: child process error`);
  return result;
}

test("canonical validator CLI exercises all lifecycle transitions from an unrelated cwd", (t) => {
  const base = temporaryDirectory(t, "stnl-node-cli-all-modes-");
  const cwd = path.join(base, "cwd externo");
  mkdirSync(cwd);

  const workspace = path.join(base, "projeto com espaços", "especificação-ção");
  writeFullWorkspace(workspace, "ready");
  let result = runCli("validate-spec-lifecycle.mjs", ["workspace", workspace], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: .* status=ready ids=6/u);

  const initBefore = path.join(base, "destino ainda inexistente");
  result = runCli("validate-spec-lifecycle.mjs", ["init-transition", initBefore, workspace], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: INIT published .* status=ready ids=6/u);

  const resumed = path.join(base, "candidato resume");
  cpSync(workspace, resumed, { recursive: true });
  const manifest = writeResumeManifest(path.join(base, "manifestação resume.json"), workspace);
  result = runCli(
    "validate-spec-lifecycle.mjs",
    ["resume-transition", workspace, resumed, "--manifest", manifest],
    { cwd },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: RESUME .* preserved IDs and external paths/u);

  const readiness = path.join(base, "cópia readiness");
  cpSync(workspace, readiness, { recursive: true });
  result = runCli(
    "validate-spec-lifecycle.mjs",
    ["readiness-transition", workspace, readiness, "--scope", "GLOBAL"],
    { cwd },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: READINESS GLOBAL .* was read-only/u);

  const [closeBefore, closeAfter] = buildClosePair(path.join(base, "close com espaços"), "ready");
  result = runCli("validate-spec-lifecycle.mjs", ["close-transition", closeBefore, closeAfter], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: CLOSE .* preserved exact authority and external directories/u);
});

for (const [name, arguments_, diagnostic] of [
  ["missing-command", [], "required: command"],
  ["legacy-planning", ["PLANNING"], "invalid choice"],
  ["missing-readiness-scope", ["readiness-transition", "before", "after"], "required: --scope"],
  ["lowercase-readiness-scope", ["readiness-transition", "before", "after", "--scope", "global"], "invalid choice"],
  ["missing-resume-manifest", ["resume-transition", "before", "after"], "required: --manifest"],
  ["unknown-option", ["workspace", "somewhere", "--legacy"], "unrecognized arguments"],
]) {
  test(`validator CLI argument contract: ${name}`, () => {
    const result = runCli("validate-spec-lifecycle.mjs", arguments_);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: validate-spec-lifecycle\.mjs/u);
    assert.match(result.stderr, new RegExp(escapeRegExp(diagnostic), "u"));
    assert.equal(result.stdout, "");
  });
}

for (const [entrypoint, prefix] of [
  ["validate-spec-lifecycle.mjs", []],
  ["create-readiness-attestation.mjs", []],
  ["build-closed-spec.mjs", []],
  ["validate-spec-lifecycle.mjs", ["workspace"]],
  ["validate-spec-lifecycle.mjs", ["init-transition"]],
  ["validate-spec-lifecycle.mjs", ["resume-transition"]],
  ["validate-spec-lifecycle.mjs", ["readiness-transition"]],
  ["validate-spec-lifecycle.mjs", ["close-transition"]],
]) {
  for (const helpFlag of ["-h", "--help"]) {
    test(`CLI help contract: ${entrypoint} ${[...prefix, helpFlag].join(" ")}`, () => {
      const result = runCli(entrypoint, [...prefix, helpFlag]);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, new RegExp(`^usage: ${escapeRegExp(entrypoint)}`, "u"));
    });
  }
}

test("CLI option syntax preserves equals, double-dash, and repeated-last-wins semantics", (t) => {
  const base = temporaryDirectory(t, "stnl-node-cli-option-syntax-");
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  writeFullWorkspace(before, "ready");
  cpSync(before, after, { recursive: true });

  let result = runCli(
    "validate-spec-lifecycle.mjs",
    ["readiness-transition", "--scope=LOCAL", "--scope", "GLOBAL", "--", before, after],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: READINESS GLOBAL/u);

  const attestation = path.join(base, "attestation.json");
  result = runCli(
    "create-readiness-attestation.mjs",
    ["--scope=LOCAL", "--scope=GLOBAL", "--verdict=NEEDS_RESUME", "--verdict=READY", "--", before, attestation],
  );
  assert.equal(result.status, 0, result.stderr);
  validateReadinessAttestation(before, attestation);

  const candidate = path.join(base, "closed");
  result = runCli(
    "build-closed-spec.mjs",
    ["--readiness-attestation=missing.json", `--readiness-attestation=${attestation}`, "--", before, candidate],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(validateWorkspace(candidate).status, "closed");
});

test("validator CLI reports validation failures as exit 1 without mutation", (t) => {
  const base = temporaryDirectory(t, "stnl-node-cli-invalid-");
  const invalid = path.join(base, "invalid workspace");
  mkdirSync(invalid);
  const before = fileSnapshot(invalid);
  const result = runCli("validate-spec-lifecycle.mjs", ["workspace", invalid], { cwd: base });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL: .*required file does not exist/mu);
  assert.equal(result.stdout, "");
  assert.equal(mapsEqual(before, fileSnapshot(invalid)), true);
});

test("readiness attestation is deterministic UTF-8 and validates from paths with spaces", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-spaces-");
  const source = path.join(base, "fonte com espaços", "especificação-ção");
  writeFullWorkspace(source, "ready");
  const first = path.join(base, "atestado um.json");
  const second = path.join(base, "atestado dois.json");
  createReadinessAttestation(source, first, { scope: "GLOBAL", verdict: "READY" });
  createReadinessAttestation(source, second, { scope: "GLOBAL", verdict: "READY" });
  assert.deepEqual(readFileSync(first), readFileSync(second));
  assert.match(readFileSync(first, "utf8"), /^\{"mode":"READINESS","scope":"GLOBAL","verdict":"READY","version":1,/u);
  const [workspace, digest] = validateReadinessAttestation(source, first);
  assert.equal(workspace.root, realpathSync(source));
  assert.equal(digest, workspaceAuthoritySnapshotSha256(workspace));
  assert.match(digest, /^[0-9a-f]{64}$/u);
});

test("readiness CLI preserves argument, success-message, and exit-code contracts", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-cli-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const output = path.join(base, "attestation.json");
  let result = runCli(
    "create-readiness-attestation.mjs",
    [source, output, "--scope", "GLOBAL", "--verdict", "READY"],
    { cwd: base },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: readiness attestation created at /u);
  assert.ok(existsSync(output));

  result = runCli("create-readiness-attestation.mjs", [source, path.join(base, "missing.json")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /required: --scope/u);

  result = runCli(
    "create-readiness-attestation.mjs",
    [source, path.join(base, "invalid.json"), "--scope", "LOCAL", "--verdict", "READY"],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL: readiness attestation requires scope GLOBAL/mu);
  assert.equal(existsSync(path.join(base, "invalid.json")), false);
});

test("tampered readiness fields and digest are rejected without changing authority", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-tamper-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const sourceBefore = workspaceSnapshot(source);
  const valid = path.join(base, "valid.json");
  createReadinessAttestation(source, valid, { scope: "GLOBAL", verdict: "READY" });
  const original = readJson(valid);
  for (const [name, mutate, expected] of [
    ["mode", (value) => { value.mode = "PLANNING"; }, "requires mode READINESS"],
    ["scope", (value) => { value.scope = "LOCAL"; }, "requires scope GLOBAL"],
    ["verdict", (value) => { value.verdict = "NEEDS_RESUME"; }, "requires verdict READY"],
    ["identity", (value) => { value.workspace_identity.h1 = "# Forged - Feature SPEC"; }, "identity does not match"],
    ["digest", (value) => { value.workspace_snapshot_sha256 = "0".repeat(64); }, "is stale"],
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    const file = path.join(base, `${name}.json`);
    write(file, `${JSON.stringify(candidate)}\n`);
    assert.throws(
      () => validateReadinessAttestation(source, file),
      (error) => error instanceof ValidationError && error.message.includes(expected),
      name,
    );
  }
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
});

test("readiness attestation becomes stale after any authority mutation", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-stale-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const attestation = path.join(base, "attestation.json");
  createReadinessAttestation(source, attestation, { scope: "GLOBAL", verdict: "READY" });
  replaceInFile(
    path.join(source, "shared", "requirements.md"),
    "according to the service UTC clock",
    "according to the authoritative service UTC clock",
  );
  assert.doesNotThrow(() => validateWorkspace(source));
  assert.throws(
    () => validateReadinessAttestation(source, attestation),
    (error) => error instanceof ValidationError && error.message.includes("is stale"),
  );
});

test("readiness attestation rejects duplicate JSON fields and oversized input", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-malformed-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const duplicate = path.join(base, "duplicate.json");
  write(
    duplicate,
    `{"version":1,"version":1,"mode":"READINESS","scope":"GLOBAL","verdict":"READY","workspace_identity":{"h1":"x","path_sha256":"${"0".repeat(64)}"},"workspace_snapshot_sha256":"${"0".repeat(64)}"}\n`,
  );
  assert.throws(
    () => validateReadinessAttestation(source, duplicate),
    (error) => error instanceof ValidationError && error.message.includes("duplicate JSON field 'version'"),
  );
  const oversized = path.join(base, "oversized.json");
  write(oversized, "x".repeat(65 * 1024));
  assert.throws(
    () => validateReadinessAttestation(source, oversized),
    (error) => error instanceof ValidationError && error.message.includes("safe size limit"),
  );
});

test("CLOSE renderer is deterministic and read-only", (t) => {
  const base = temporaryDirectory(t, "stnl-node-render-close-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  write(path.join(source, "execution", "preservado-ção.txt"), "estado externo em UTF-8: ação\n");
  const before = workspaceSnapshot(source);
  const first = renderClosedFeature(source);
  const second = renderClosedFeature(source);
  assert.ok(Buffer.isBuffer(first));
  assert.deepEqual(first, second);
  assert.deepEqual(workspaceSnapshot(source), before);
  assert.match(first.toString("utf8"), /## Final Acceptance Criteria/u);
  assert.doesNotMatch(first.toString("utf8"), /## Canonical Artifact Index/u);
});

test("CLOSE builder validates attestation, preserves external state, and leaves source untouched", (t) => {
  const base = temporaryDirectory(t, "stnl-node-build-close-");
  const source = path.join(base, "fonte com espaços");
  const candidate = path.join(base, "candidato fechado com espaços");
  writeFullWorkspace(source, "ready");
  write(path.join(source, "execution", "evidência.txt"), "evidência externa íntegra\n");
  const sourceBefore = workspaceSnapshot(source);
  const attestation = path.join(base, "readiness global.json");
  createReadinessAttestation(source, attestation, { scope: "GLOBAL", verdict: "READY" });
  const built = buildClosedCandidate(source, candidate, { readinessAttestation: attestation });
  assert.equal(built, realpathSync(candidate));
  const closed = validateWorkspace(candidate);
  assert.equal(closed.status, "closed");
  validateCloseTransition(source, candidate);
  assert.equal(readFileSync(path.join(candidate, "execution", "evidência.txt"), "utf8"), "evidência externa íntegra\n");
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
  assert.equal(existsSync(path.join(candidate, "shared")), false);
});

test("CLOSE builder CLI success and failure exit contracts", (t) => {
  const base = temporaryDirectory(t, "stnl-node-build-close-cli-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const attestation = path.join(base, "attestation.json");
  createReadinessAttestation(source, attestation, { scope: "GLOBAL", verdict: "READY" });
  const candidate = path.join(base, "closed");
  let result = runCli(
    "build-closed-spec.mjs",
    [source, candidate, "--readiness-attestation", attestation],
    { cwd: base },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: deterministic CLOSE candidate built at /u);
  assert.equal(validateWorkspace(candidate).status, "closed");

  result = runCli("build-closed-spec.mjs", [source, path.join(base, "missing-attestation")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /required: --readiness-attestation/u);

  result = runCli(
    "build-closed-spec.mjs",
    [source, path.join(base, "duplicate"), "--readiness-attestation", attestation],
  );
  assert.equal(result.status, 0, result.stderr);
  result = runCli(
    "build-closed-spec.mjs",
    [source, path.join(base, "duplicate"), "--readiness-attestation", attestation],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL: candidate must not exist/mu);
});

test("CLOSE is blocked by a stale attestation and publishes no candidate", (t) => {
  const base = temporaryDirectory(t, "stnl-node-build-close-stale-");
  const source = path.join(base, "source");
  const candidate = path.join(base, "candidate");
  writeFullWorkspace(source, "ready");
  const attestation = path.join(base, "attestation.json");
  createReadinessAttestation(source, attestation, { scope: "GLOBAL", verdict: "READY" });
  replaceInFile(
    path.join(source, "shared", "acceptance-criteria.md"),
    "envelope público",
    "envelope público estável",
  );
  assert.throws(
    () => buildClosedCandidate(source, candidate, { readinessAttestation: attestation }),
    (error) => error instanceof ValidationError && error.message.includes("is stale"),
  );
  assert.equal(existsSync(candidate), false);
  assert.deepEqual(
    readdirSync(base).filter((name) => name.includes("close-stage")),
    [],
    "failed CLOSE left a stage behind",
  );
});

function createSymlinkOrSkip(t, target, link, type) {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`symlinks are unavailable on this filesystem: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function replaceWithHardlinkOrSkip(t, file, outside) {
  const bytes = readFileSync(file);
  writeFileSync(outside, bytes);
  unlinkSync(file);
  try {
    linkSync(outside, file);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      t.skip(`hardlinks are unavailable on this filesystem: ${error.code}`);
      return null;
    }
    throw error;
  }
  const fileMetadata = lstatSync(file);
  const outsideMetadata = lstatSync(outside);
  assert.equal(fileMetadata.ino, outsideMetadata.ino);
  assert.equal(fileMetadata.nlink, 2);
  return bytes;
}

test("workspace root symlink aliases are rejected without dereferencing or mutation", (t) => {
  const base = temporaryDirectory(t, "stnl-node-workspace-root-symlink-");
  const source = path.join(base, "source");
  const alias = path.join(base, "alias");
  writeFullWorkspace(source, "ready");
  const before = workspaceSnapshot(source);
  if (!createSymlinkOrSkip(t, source, alias, "dir")) return;
  assert.throws(
    () => validateWorkspace(alias),
    (error) => error instanceof ValidationError && error.message.includes("workspace root must not be a symlink"),
  );
  assert.equal(readlinkSync(alias), source);
  assert.deepEqual(workspaceSnapshot(source), before);
});

for (const [name, relative, expected] of [
  ["feature authority", "feature_spec.md", "feature_spec.md must be a real file"],
  ["shared category", "shared/requirements.md", "unexpected lifecycle artifact"],
]) {
  test(`${name} symlink is rejected and its target remains byte-identical`, (t) => {
    const base = temporaryDirectory(t, `stnl-node-${name.replaceAll(" ", "-")}-symlink-`);
    const source = path.join(base, "source");
    const victim = path.join(source, ...relative.split("/"));
    const outside = path.join(base, "outside.md");
    writeFullWorkspace(source, "ready");
    const bytes = readFileSync(victim);
    writeFileSync(outside, bytes);
    unlinkSync(victim);
    if (!createSymlinkOrSkip(t, outside, victim, "file")) return;
    assert.throws(
      () => validateWorkspace(source),
      (error) => error instanceof ValidationError && error.message.includes(expected),
    );
    assert.deepEqual(readFileSync(outside), bytes);
    assert.equal(lstatSync(victim).isSymbolicLink(), true);
  });
}

test("shared directory symlink is rejected without touching the external directory", (t) => {
  const base = temporaryDirectory(t, "stnl-node-shared-symlink-");
  const source = path.join(base, "source");
  const outside = path.join(base, "outside-shared");
  writeFullWorkspace(source, "ready");
  renameSync(path.join(source, "shared"), outside);
  if (!createSymlinkOrSkip(t, outside, path.join(source, "shared"), "dir")) return;
  const before = fileSnapshot(outside);
  assert.throws(
    () => validateWorkspace(source),
    (error) => error instanceof ValidationError && error.message.includes("shared must be a real directory"),
  );
  assert.equal(mapsEqual(before, fileSnapshot(outside)), true);
});

for (const [name, relative, expected] of [
  ["feature authority", "feature_spec.md", "single-link regular file"],
  ["shared authority", "shared/requirements.md", "single-link regular file"],
]) {
  test(`${name} hardlink is rejected and remains intact`, (t) => {
    const base = temporaryDirectory(t, `stnl-node-${name.replaceAll(" ", "-")}-hardlink-`);
    const source = path.join(base, "source");
    const victim = path.join(source, ...relative.split("/"));
    const outside = path.join(base, "outside.md");
    writeFullWorkspace(source, "ready");
    const bytes = replaceWithHardlinkOrSkip(t, victim, outside);
    if (bytes === null) return;
    assert.throws(
      () => validateWorkspace(source),
      (error) => error instanceof ValidationError && error.message.includes(expected),
    );
    assert.deepEqual(readFileSync(victim), bytes);
    assert.deepEqual(readFileSync(outside), bytes);
    assert.equal(lstatSync(victim).ino, lstatSync(outside).ino);
    assert.equal(lstatSync(victim).nlink, 2);
  });
}

test("readiness rejects external hardlink topology changes even when bytes match", (t) => {
  const base = temporaryDirectory(t, "stnl-node-readiness-hardlink-topology-");
  const before = path.join(base, "before");
  const after = path.join(base, "after");
  const outside = path.join(base, "outside.txt");
  writeFullWorkspace(before, "ready");
  write(path.join(before, "execution", "victim.txt"), "byte-identical external state\n");
  cpSync(before, after, { recursive: true });
  const victim = path.join(after, "execution", "victim.txt");
  const bytes = replaceWithHardlinkOrSkip(t, victim, outside);
  if (bytes === null) return;
  const beforeSnapshot = workspaceSnapshot(before);
  const afterSnapshot = workspaceSnapshot(after);
  assert.notDeepEqual(afterSnapshot, beforeSnapshot);
  assert.throws(
    () => validateReadinessTransition(before, after, "GLOBAL"),
    (error) => error instanceof ValidationError && error.message.includes("mutated the workspace"),
  );
  assert.deepEqual(readFileSync(victim), bytes);
  assert.deepEqual(readFileSync(outside), bytes);
});

test("readiness attestation rejects symlink and hardlink aliases", (t) => {
  const base = temporaryDirectory(t, "stnl-node-attestation-alias-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const attestation = path.join(base, "attestation.json");
  createReadinessAttestation(source, attestation, { scope: "GLOBAL", verdict: "READY" });

  const symlink = path.join(base, "attestation-symlink.json");
  if (createSymlinkOrSkip(t, attestation, symlink, "file")) {
    assert.throws(
      () => validateReadinessAttestation(source, symlink),
      (error) => error instanceof ValidationError && error.message.includes("must not contain symlink components"),
    );
  }

  const hardlink = path.join(base, "attestation-hardlink.json");
  try {
    linkSync(attestation, hardlink);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      t.skip(`hardlinks are unavailable on this filesystem: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(
    () => validateReadinessAttestation(source, hardlink),
    (error) => error instanceof ValidationError && error.message.includes("single-link regular file"),
  );
  assert.equal(lstatSync(attestation).nlink, 2);
  assert.equal(lstatSync(hardlink).ino, lstatSync(attestation).ino);
});

test("path traversal aliases are rejected even when they resolve to the same workspace", (t) => {
  const base = temporaryDirectory(t, "stnl-node-path-traversal-alias-");
  const source = path.join(base, "source");
  writeFullWorkspace(source, "ready");
  const alias = `${source}${path.sep}..${path.sep}${path.basename(source)}`;
  assert.equal(path.resolve(alias), path.resolve(source));
  assert.throws(
    () => validateWorkspace(alias),
    (error) => error instanceof ValidationError && error.message.includes("must not contain path traversal"),
  );
  const attestation = path.join(base, "attestation.json");
  assert.throws(
    () => createReadinessAttestation(alias, attestation, { scope: "GLOBAL", verdict: "READY" }),
    (error) => error instanceof ValidationError && error.message.includes("must not contain path traversal"),
  );
  assert.equal(existsSync(attestation), false);
});

test("failed INIT, RESUME, READINESS, and CLOSE validations mutate no input", (t) => {
  const base = temporaryDirectory(t, "stnl-node-no-mutation-failures-");

  const initBefore = path.join(base, "init-before");
  const initAfter = path.join(base, "init-after");
  writeFullWorkspace(initBefore, "ready");
  writeFullWorkspace(initAfter, "ready");
  const initBeforeSnapshot = workspaceSnapshot(initBefore);
  const initAfterSnapshot = workspaceSnapshot(initAfter);
  assert.throws(
    () => validateInitTransition(initBefore, initAfter),
    (error) => error instanceof ValidationError && error.message.includes("must not exist"),
  );
  assert.deepEqual(workspaceSnapshot(initBefore), initBeforeSnapshot);
  assert.deepEqual(workspaceSnapshot(initAfter), initAfterSnapshot);

  const resumeBefore = path.join(base, "resume-before");
  const resumeAfter = path.join(base, "resume-after");
  writeFullWorkspace(resumeBefore, "ready");
  cpSync(resumeBefore, resumeAfter, { recursive: true });
  replaceInFile(
    path.join(resumeAfter, "shared", "requirements.md"),
    "according to the service UTC clock",
    "according to a rewritten clock authority",
  );
  const manifest = writeResumeManifest(path.join(base, "resume.json"), resumeBefore);
  const resumeBeforeSnapshot = workspaceSnapshot(resumeBefore);
  const resumeAfterSnapshot = workspaceSnapshot(resumeAfter);
  assert.throws(
    () => validateResumeTransition(resumeBefore, resumeAfter, manifest),
    (error) => error instanceof ValidationError && error.message.includes("allowed_existing_ids"),
  );
  assert.deepEqual(workspaceSnapshot(resumeBefore), resumeBeforeSnapshot);
  assert.deepEqual(workspaceSnapshot(resumeAfter), resumeAfterSnapshot);

  const readinessBefore = path.join(base, "readiness-before");
  const readinessAfter = path.join(base, "readiness-after");
  writeFullWorkspace(readinessBefore, "ready");
  cpSync(readinessBefore, readinessAfter, { recursive: true });
  replaceInFile(path.join(readinessAfter, "feature_spec.md"), "deterministic invitation", "consistent invitation");
  const readinessBeforeSnapshot = workspaceSnapshot(readinessBefore);
  const readinessAfterSnapshot = workspaceSnapshot(readinessAfter);
  assert.throws(
    () => validateReadinessTransition(readinessBefore, readinessAfter, "GLOBAL"),
    (error) => error instanceof ValidationError && error.message.includes("mutated the workspace"),
  );
  assert.deepEqual(workspaceSnapshot(readinessBefore), readinessBeforeSnapshot);
  assert.deepEqual(workspaceSnapshot(readinessAfter), readinessAfterSnapshot);

  const [closeBefore, closeAfter] = buildClosePair(path.join(base, "close"), "ready");
  replaceInFile(
    path.join(closeAfter, "feature_spec.md"),
    "All clients observe one deterministic expiration decision.",
    "Clients observe a changed expiration decision.",
  );
  const closeBeforeSnapshot = workspaceSnapshot(closeBefore);
  const closeAfterSnapshot = workspaceSnapshot(closeAfter);
  assert.throws(
    () => validateCloseTransition(closeBefore, closeAfter),
    (error) => error instanceof ValidationError && error.message.includes("changed canonical content"),
  );
  assert.deepEqual(workspaceSnapshot(closeBefore), closeBeforeSnapshot);
  assert.deepEqual(workspaceSnapshot(closeAfter), closeAfterSnapshot);
});

const coverageCases = [
  {
    name: "active acceptance criterion requires verifies",
    mutate(root) {
      replaceInFile(path.join(root, "shared", "acceptance-criteria.md"), "- verifies: [R-001]\n", "");
    },
    valid: false,
    error: "missing required metadata",
  },
  {
    name: "in-scope requirement requires coverage",
    mutate(root) { appendRequirement(root, requirementItem({ identifier: "R-002" })); },
    valid: false,
    error: "has no active AC coverage or formal coverage_justification",
  },
  {
    name: "material formal coverage justification is accepted",
    mutate(root) {
      appendRequirement(root, requirementItem({
        identifier: "R-002",
        coverageJustification: "Verified entirely by an immutable upstream protocol contract.",
      }));
    },
    valid: true,
  },
  {
    name: "placeholder coverage justification is rejected",
    mutate(root) {
      appendRequirement(root, requirementItem({ identifier: "R-002", coverageJustification: "N/A" }));
    },
    valid: false,
    error: "coverage_justification",
  },
  {
    name: "stale justification on covered requirement is rejected",
    mutate(root) {
      replaceInFile(
        path.join(root, "shared", "requirements.md"),
        "- status: in_scope\n",
        "- status: in_scope\n- coverage_justification: Covered by a separate immutable protocol check.\n",
      );
    },
    valid: false,
    error: "stale coverage_justification",
  },
  {
    name: "AC cannot verify a missing requirement",
    mutate(root) {
      replaceInFile(path.join(root, "shared", "acceptance-criteria.md"), "- verifies: [R-001]", "- verifies: [R-999]");
    },
    valid: false,
    error: "calculated broken_references",
  },
  {
    name: "AC cannot verify a non-requirement",
    mutate(root) {
      replaceInFile(path.join(root, "shared", "acceptance-criteria.md"), "- verifies: [R-001]", "- verifies: [RK-001]");
    },
    valid: false,
    error: "verifies contains incompatible prefix",
  },
  {
    name: "AC cannot cover an out-of-scope requirement",
    mutate(root) {
      replaceInFile(path.join(root, "shared", "requirements.md"), "- status: in_scope", "- status: out_of_scope");
    },
    valid: false,
    error: "verifies non-in-scope requirement",
  },
];

for (const case_ of coverageCases) {
  test(`coverage contract: ${case_.name}`, (t) => {
    const base = temporaryDirectory(t, "stnl-node-coverage-");
    const root = path.join(base, "workspace");
    writeFullWorkspace(root, "ready");
    case_.mutate(root);
    const before = fileSnapshot(root);
    if (case_.valid) {
      const workspace = validateWorkspace(root);
      assert.equal(workspace.status, "ready");
      assert.ok(workspace.items.has("R-002"));
    } else {
      assert.throws(
        () => validateWorkspace(root),
        (error) => error instanceof ValidationError && error.message.includes(case_.error),
      );
    }
    assert.equal(mapsEqual(before, fileSnapshot(root)), true, `${case_.name}: validation mutated fixture`);
  });
}

const relationshipCases = [
  {
    name: "open non-blocking question may remain in a ready SPEC",
    mutate(root) {
      write(path.join(root, "shared", "questions.md"), sharedDocument(
        "shared-questions.template.md", "ready", "Questions", questionItem("open", "non_blocking"),
      ));
    },
    valid: true,
  },
  {
    name: "non-blocking question cannot carry blocks",
    mutate(root) {
      const item = questionItem("open", "non_blocking").replace(
        "- classification: non_blocking",
        "- classification: non_blocking\n- blocks: [AC-001]",
      );
      write(path.join(root, "shared", "questions.md"), sharedDocument(
        "shared-questions.template.md", "ready", "Questions", item,
      ));
    },
    valid: false,
    error: "non-blocking open state cannot contain blocks",
  },
  {
    name: "question classification is mandatory",
    mutate(root) { replaceInFile(path.join(root, "shared", "questions.md"), "- classification: blocking\n", ""); },
    valid: false,
    error: "missing required metadata",
  },
  {
    name: "irrelevant open question is rejected",
    mutate(root) {
      write(path.join(root, "shared", "questions.md"), sharedDocument(
        "shared-questions.template.md", "ready", "Questions", questionItem("open", "irrelevant"),
      ));
    },
    valid: false,
    error: "irrelevant questions cannot remain open",
  },
];

for (const case_ of relationshipCases) {
  test(`relationship contract: ${case_.name}`, (t) => {
    const base = temporaryDirectory(t, "stnl-node-relationship-");
    const root = path.join(base, "workspace");
    writeFullWorkspace(root, "ready");
    case_.mutate(root);
    const before = fileSnapshot(root);
    if (case_.valid) {
      const workspace = validateWorkspace(root);
      assert.deepEqual(workspace.openQuestions, ["Q-001"]);
      assert.deepEqual(workspace.blockingQuestions, []);
    } else {
      assert.throws(
        () => validateWorkspace(root),
        (error) => error instanceof ValidationError && error.message.includes(case_.error),
      );
    }
    assert.equal(mapsEqual(before, fileSnapshot(root)), true);
  });
}

test("template structure remains compact, canonical, and independently materializable", () => {
  const templates = CATEGORIES.map((category) => path.join(
    TEMPLATE_ROOT,
    `shared-${category.filename.replace(/\.md$/u, "")}.template.md`,
  ));
  assert.equal(templates.length, 6);
  for (const file of templates) {
    const text = readFileSync(file, "utf8");
    const afterHeader = text.replace(/^# File Purpose Header\n\n```yaml\n[\s\S]*?```\n\n/u, "");
    assert.doesNotMatch(afterHeader, /```(?:yaml|markdown)/u, file);
    assert.match(afterHeader, /^### (?:AC|RK|R|D|C|Q)-\d{3} — /mu, file);
    assert.doesNotMatch(afterHeader, /^id:\s*(?:AC|RK|R|D|C|Q)-/mu, file);
    assert.doesNotMatch(afterHeader, /\bnull\b/iu, file);
    assert.doesNotMatch(afterHeader, /^references:/mu, file);
  }
  const active = readFileSync(path.join(TEMPLATE_ROOT, "feature_spec.template.md"), "utf8");
  assert.equal((active.match(/```yaml/gu) ?? []).length, 3);
  assert.match(active, /artifacts: \{\}/u);
  assert.match(active, /blocking_questions: \[\]/u);
  assert.doesNotMatch(active, /broken_references/u);
  assert.deepEqual(ACTIVE_SECTIONS, [
    "Objective",
    "Context",
    "Scope",
    "Out of Scope",
    "Requirements",
    "Business Rules",
    "Relevant Contracts",
    "Canonical Artifact Index",
    "Blockers",
    "Selective Reading",
  ]);
});
