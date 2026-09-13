#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_FILES = new Set(["plan.md", "tasks.md"]);
const ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SLICE_FILE = /^slice-(?:[0-9]{2}|[1-9][0-9]{2,})\.md$/u;
const SLICE_OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const OPERATIONS = new Set([
  "PLAN", "REVIEW_PLAN", "MATERIALIZE_TASKS", "REVIEW_TASKS", "REPLAN",
  "EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE", "CLOSE",
]);
export const EXECUTION_WORKFLOW_SKILLS = Object.freeze({
  PLAN: "stnl-execution-planner",
  REPLAN: "stnl-execution-planner",
  REVIEW_PLAN: "stnl-plan-reviewer",
  MATERIALIZE_TASKS: "stnl-task-materializer",
  REVIEW_TASKS: "stnl-task-reviewer",
  EXECUTE_SLICE: "stnl-slice-executor",
  APPLY_FINDINGS: "stnl-slice-executor",
  VALIDATE_SLICE: "stnl-slice-quality-manager",
  CLOSE: "stnl-execution-closer",
});
const OPERATION_STATES = new Map([
  ["PLAN", new Set(["EMPTY"])],
  ["REVIEW_PLAN", new Set(["PLANNED_DRAFT", "PLANNED_READY", "PENDING_REPLAN_DRAFT", "PENDING_REPLAN_READY"])],
  ["MATERIALIZE_TASKS", new Set(["PLANNED_READY", "PENDING_REPLAN_READY"])],
  ["REVIEW_TASKS", new Set(["MATERIALIZED_PRISTINE"])],
  ["REPLAN", new Set(["PLANNED_DRAFT", "PLANNED_READY", "MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "REQUIREMENTS_CHANGED", "DIVERGENCE_BLOCKED", "VALIDATION_BLOCKED", "IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "REPLAN_REQUIRED", "COMPLETE"])],
  ["EXECUTE_SLICE", new Set(["DIVERGENCE_BLOCKED", "MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
  ["APPLY_FINDINGS", new Set(["DIVERGENCE_BLOCKED", "VALIDATION_NEEDS_FIX", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
  ["VALIDATE_SLICE", new Set(["VALIDATION_NEEDS_FIX", "DIVERGENCE_BLOCKED", "IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "VALIDATION_BLOCKED", "IMPLEMENTATION_RETRY_EXHAUSTED", "FINDINGS_RETRY_EXHAUSTED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
  ["CLOSE", new Set(["COMPLETE"])],
]);
const CURRENT_AUTHORITY = /^sha256:([0-9a-f]{64})$/u;
const CANONICAL_AUTHORITY_REFERENCE = /^(?:R|AC|D|C|RK|Q)-[0-9]{3}$/u;
const CANONICAL_AUTHORITY_REFERENCE_PATTERN = /\b(?:R|AC|D|C|RK|Q)-[0-9]{3}\b/gu;
// v1 persists only terminal harness observations.  OBSERVED, evidence-level
// SUPERSEDED and STALE_EVIDENCE have no producer or authorized transition.
const VALIDATION_EVIDENCE_LIFECYCLE = new Map([
  ["VERIFIED", new Map([["NONE", new Set(["NONE", "VALIDATION_FINDING", "CODE_REGRESSION"])]] )],
  ["INVALID", new Map([
    ["VALIDATION_SIDE_EFFECT", new Set(["NONE"])],
    ["INVALID_REPLAY", new Set(["NONE"])],
    ["INFRASTRUCTURE_BLOCKED", new Set(["NONE"])],
  ])],
]);
const VALIDATION_EVIDENCE_STATES = new Set(VALIDATION_EVIDENCE_LIFECYCLE.keys());
const VALIDATION_EVIDENCE_CLASSIFICATIONS = new Set([...VALIDATION_EVIDENCE_LIFECYCLE.values()]
  .flatMap((classifications) => [...classifications.keys()]));
const VALIDATION_CONCLUSIONS = new Set(["NONE", "VALIDATION_FINDING", "CODE_REGRESSION"]);
const HASH_DOMAIN = Buffer.from("stnl-requirements-authority-v1\0", "utf8");
const PRISTINE = new Map([
  ["Changed Areas", "- pending"],
  ["Scope Expansion", "- none"],
  ["Prior Validation Overlap", "- none"],
  ["Divergences", "- none"],
  ["Delegation Blocker", "- none"],
  ["Implementation Test Evidence", "- none"],
  ["Findings Test Evidence", "- none"],
  ["Validation Attempts", "- none"],
  ["Validation Findings", "- none"],
  ["Corrections Applied", "- none"],
  ["Effective Validation Base", "- none"],
  ["Diff Summary", "- pending"],
  ["Final Result", "- pending"],
]);
const GLOBAL_PLAN_SECTIONS = ["Global Context", "Serial Slice Order", "Global Risks and Integration"];
const SLICE_PLAN_SECTIONS = [
  "References", "Objective and Observable Result", "Requirements", "Included Scope", "Out of Scope and Boundaries",
  "Likely Areas", "Dependencies", "Risks and Strategy", "Expected Tests", "Completion Criterion",
];
const TASK_SECTIONS = [
  "References", "Checklist", "Expected Tests", "Changed Areas", "Scope Expansion", "Prior Validation Overlap",
  "Divergences", "Delegation Blocker", "Implementation Test Evidence", "Findings Test Evidence", "Validation Attempts",
  "Validation Findings", "Corrections Applied", "Effective Validation Base", "Diff Summary", "Final Result",
];
const ACTIVE_TO_CLOSED = new Map([
  ["Objective", "Objective"],
  ["Context", "Context"],
  ["Scope", "Final Scope"],
  ["Out of Scope", "Out of Scope"],
  ["Business Rules", "Business Rules"],
  ["Relevant Contracts", "Important Contracts"],
]);
const CLOSED_RECORD_SECTIONS = new Set([
  "Requirements", "Final Acceptance Criteria", "Durable Decisions", "Relevant Constraints",
  "Relevant Risks", "Durable Resolved Questions",
]);
const PURPOSE_HEADER_FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"];

export class ExecutionContractError extends Error {
  constructor(message, findings = [], recoveryTargets = [], contractViolation = null) {
    super(message);
    this.name = "ExecutionContractError";
    this.findings = findings;
    this.recoveryTargets = recoveryTargets;
    this.contractViolation = contractViolation;
  }
}

export function isIgnoredMetadata(name) {
  return name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function requireRealFile(filePath, label) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ExecutionContractError(`${label} must be a single-link real file: ${filePath}`, [filePath]);
  }
  return filePath;
}

async function assertNoSymlinkComponents(filePath, label) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatOrNull(current);
    if (metadata === null) break;
    if (metadata.isSymbolicLink()) {
      const allowedDarwinAlias = process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(current);
      if (!allowedDarwinAlias) throw new ExecutionContractError(`${label} contains a symlink component: ${current}`);
    }
  }
}

export async function resolveExecutionWorkspace(specPath) {
  const requested = path.resolve(String(specPath));
  await assertNoSymlinkComponents(requested, "SPEC_PATH");
  const requestedMetadata = await lstatOrNull(requested);
  if (requestedMetadata === null) {
    throw new ExecutionContractError(`SPEC_PATH must exist and must not be a symlink: ${requested}`);
  }
  const physical = await fs.realpath(requested);
  const metadata = await lstatOrNull(physical);
  if (metadata.isDirectory()) {
    const authorityPath = path.join(physical, "feature_spec.md");
    await requireRealFile(authorityPath, "workspace feature_spec.md");
    return { kind: "lifecycle", specRoot: physical, authorityPath, executionRoot: path.join(physical, "execution") };
  }
  if (!metadata.isFile()) throw new ExecutionContractError(`SPEC_PATH must be a workspace directory or requirements file: ${physical}`);
  await requireRealFile(physical, "standalone requirements source");
  if (path.basename(physical) === "feature_spec.md") {
    return { kind: "lifecycle", specRoot: path.dirname(physical), authorityPath: physical, executionRoot: path.join(path.dirname(physical), "execution") };
  }
  const parsed = path.parse(physical);
  return { kind: "standalone", specRoot: null, authorityPath: physical, executionRoot: path.join(parsed.dir, `${parsed.name}-execution`) };
}

async function inspectSliceDirectory(directory, findings, { required }) {
  const metadata = await lstatOrNull(directory);
  if (metadata === null) {
    if (required) findings.push(directory);
    return [];
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    findings.push(directory);
    return [];
  }
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !SLICE_FILE.test(entry.name)) findings.push(entryPath);
    else names.push(entry.name);
  }
  return names.sort();
}

export async function findNonCanonicalExecutionPaths(specPath, { allowAbsent = false, allowPlanned = false } = {}) {
  const { specRoot, executionRoot } = await resolveExecutionWorkspace(specPath);
  const findings = [];
  // Lifecycle owns only feature_spec.md/shared. Other SPEC-root siblings are user-owned and preserved.
  if (specRoot !== null) {
    const runbook = path.join(specRoot, "test-runbook");
    const runbookMetadata = await lstatOrNull(runbook);
    if (runbookMetadata !== null && (runbookMetadata.isSymbolicLink() || !runbookMetadata.isDirectory())) findings.push(runbook);
  }
  const rootMetadata = await lstatOrNull(executionRoot);
  if (rootMetadata === null) return allowAbsent ? findings : [...findings, executionRoot].sort();
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return [...findings, executionRoot].sort();
  const entries = (await fs.readdir(executionRoot, { withFileTypes: true })).filter((entry) => !isIgnoredMetadata(entry.name));
  if (entries.length === 0 && allowAbsent) return findings.sort();
  for (const entry of entries) {
    const entryPath = path.join(executionRoot, entry.name);
    if (ROOT_FILES.has(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) findings.push(entryPath);
    } else if (ROOT_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) findings.push(entryPath);
    } else findings.push(entryPath);
  }
  const plan = path.join(executionRoot, "plan.md");
  const tasksIndex = path.join(executionRoot, "tasks.md");
  if (await lstatOrNull(plan) === null) findings.push(plan);
  const planNames = await inspectSliceDirectory(path.join(executionRoot, "plans"), findings, { required: true });
  const taskIndexExists = await lstatOrNull(tasksIndex) !== null;
  const tasksDirectoryExists = await lstatOrNull(path.join(executionRoot, "tasks")) !== null;
  const plannedOnly = allowPlanned && !taskIndexExists && !tasksDirectoryExists;
  let taskNames = [];
  if (!plannedOnly) {
    if (!taskIndexExists) findings.push(tasksIndex);
    taskNames = await inspectSliceDirectory(path.join(executionRoot, "tasks"), findings, { required: true });
    // A pending REPLAN may append plan-only slices or stage a full pristine
    // replacement. Exact plan/task mapping is therefore a content/state rule,
    // not a raw layout rule.
    const planText = await fs.readFile(plan, "utf8").catch(() => "");
    const pendingReplan = /^- Revision mode: (?:pristine-replacement|append-only-extension)$/gmu.test(planText);
    if (!pendingReplan) {
      const allNames = new Set([...planNames, ...taskNames]);
      for (const name of allNames) {
        if (!planNames.includes(name)) findings.push(path.join(executionRoot, "plans", name));
        if (!taskNames.includes(name)) findings.push(path.join(executionRoot, "tasks", name));
      }
    }
  }
  return [...new Set(findings)].sort();
}

export async function validateExecutionLayout(specPath, options = {}) {
  const findings = await findNonCanonicalExecutionPaths(specPath, options);
  if (findings.length !== 0) throw new ExecutionContractError(`execution layout contains non-canonical paths: ${findings.join(", ")}`, findings);
}

function normalizeText(value) {
  return String(value).replaceAll("\r\n", "\n").trim();
}

function parsePurpose(text, label) {
  const match = text.match(/^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n\n/u);
  if (match === null) throw new ExecutionContractError(`${label} is missing the File Purpose Header`);
  const header = new Map();
  for (const line of match[1].split("\n").filter(Boolean)) {
    const field = line.match(/^([a-z_]+): (\S.*)$/u);
    if (field === null || header.has(field[1])) throw new ExecutionContractError(`${label} has a malformed File Purpose Header`);
    header.set(field[1], field[2]);
  }
  const keys = [...header.keys()];
  if (keys.length !== PURPOSE_HEADER_FIELDS.length || keys.some((key, index) => key !== PURPOSE_HEADER_FIELDS[index])) {
    throw new ExecutionContractError(`${label} has non-canonical File Purpose Header fields`);
  }
  return { header, body: text.slice(match[0].length) };
}

function sections(body) {
  const result = new Map();
  const matches = [...body.matchAll(/^## ([^\n]+)\n/gmu)];
  for (let index = 0; index < matches.length; index += 1) {
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    if (result.has(matches[index][1])) throw new ExecutionContractError(`duplicate section: ${matches[index][1]}`);
    result.set(matches[index][1], normalizeText(body.slice(matches[index].index + matches[index][0].length, end)));
  }
  return result;
}

function requireCanonicalSections(parsed, expected, label) {
  const actual = [...parsed.keys()];
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new ExecutionContractError(`${label} has non-canonical sections`);
  }
}

function field(body, name, { required = true } = {}) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const markers = [...String(body).matchAll(new RegExp(`^- ${escaped}:.*$`, "gmu"))];
  if (markers.length === 0 && !required) return null;
  if (markers.length !== 1) throw new ExecutionContractError(`expected exactly one '${name}' field`);
  const populated = markers[0][0].match(new RegExp(`^- ${escaped}: (.+)$`, "mu"));
  if (populated === null) throw new ExecutionContractError(`${name} must be an inline populated field`);
  return populated[1].trim();
}

function authorityFields(body, label) {
  const rawAuthority = field(body, "Requirements authority");
  const match = rawAuthority.match(CURRENT_AUTHORITY);
  if (match === null) throw new ExecutionContractError(`${label} has an invalid Requirements authority`);
  const rawRevision = field(body, "Plan revision");
  if (!/^[1-9][0-9]*$/u.test(rawRevision)) throw new ExecutionContractError(`${label} has an invalid Plan revision`);
  return { fingerprint: match[1], revision: Number(rawRevision) };
}

function canonicalRecords(text) {
  const matches = [...text.matchAll(/^### ((?:R|AC|D|C|RK|Q)-[0-9]{3}) — [^\n]+$/gmu)];
  const result = [];
  for (let index = 0; index < matches.length; index += 1) {
    const nextH3 = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const nextH2 = text.indexOf("\n## ", matches[index].index + 1);
    const end = nextH2 >= 0 && nextH2 < nextH3 ? nextH2 : nextH3;
    result.push([matches[index][1], normalizeText(text.slice(matches[index].index, end))]);
  }
  return result;
}

function stableEncode(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function lifecycleProjection(workspace) {
  const featureText = await fs.readFile(workspace.authorityPath, "utf8");
  const { header, body } = parsePurpose(featureText, "feature_spec.md");
  const status = header.get("status");
  const featureSections = sections(body);
  const h1 = body.match(/^# ([^\n]+)$/mu)?.[1];
  if (!h1) throw new ExecutionContractError("feature_spec.md has no canonical H1");
  const core = [];
  const records = [];
  if (status === "closed") {
    for (const [, closed] of ACTIVE_TO_CLOSED) {
      if (!featureSections.has(closed)) throw new ExecutionContractError(`closed feature_spec.md is missing ${closed}`);
      core.push([closed, featureSections.get(closed)]);
    }
    for (const heading of CLOSED_RECORD_SECTIONS) {
      if (featureSections.has(heading)) records.push(...canonicalRecords(`## ${heading}\n\n${featureSections.get(heading)}\n`));
    }
  } else {
    if (!["draft", "blocked", "ready"].includes(status)) throw new ExecutionContractError(`feature_spec.md has unsupported lifecycle status ${status}`);
    for (const [active, closed] of ACTIVE_TO_CLOSED) {
      if (!featureSections.has(active)) throw new ExecutionContractError(`active feature_spec.md is missing ${active}`);
      core.push([closed, featureSections.get(active)]);
    }
    const shared = path.join(workspace.specRoot, "shared");
    const sharedMetadata = await lstatOrNull(shared);
    if (sharedMetadata !== null) {
      if (sharedMetadata.isSymbolicLink() || !sharedMetadata.isDirectory()) throw new ExecutionContractError("shared must be a real directory");
      for (const entry of (await fs.readdir(shared, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (isIgnoredMetadata(entry.name)) continue;
        if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) throw new ExecutionContractError(`shared contains a non-canonical authority entry: ${entry.name}`);
        const sharedPath = path.join(shared, entry.name);
        await requireRealFile(sharedPath, `shared authority entry ${entry.name}`);
        const sharedText = await fs.readFile(sharedPath, "utf8");
        records.push(...canonicalRecords(parsePurpose(sharedText, entry.name).body));
      }
    }
  }
  records.sort(([left], [right]) => left.localeCompare(right, "en"));
  if (new Set(records.map(([identifier]) => identifier)).size !== records.length) throw new ExecutionContractError("lifecycle authority contains duplicate canonical IDs");
  return { h1, core, records };
}

async function lifecycleStatusForExecution(workspace) {
  if (workspace.kind !== "lifecycle") return null;
  const featureText = await fs.readFile(workspace.authorityPath, "utf8");
  const status = parsePurpose(featureText, "feature_spec.md").header.get("status");
  if (!new Set(["draft", "blocked", "ready", "closed"]).has(status)) {
    throw new ExecutionContractError(`feature_spec.md has unsupported lifecycle status ${status}`);
  }
  return status;
}

export async function computeRequirementsAuthority(specPath) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const payload = workspace.kind === "standalone"
    ? await fs.readFile(workspace.authorityPath)
    : stableEncode(await lifecycleProjection(workspace));
  return createHash("sha256").update(HASH_DOMAIN).update(payload).digest("hex");
}

function authorityRecordIsActive(body) {
  const status = body.match(/^- status: (\S+)$/mu)?.[1]?.toLowerCase() ?? null;
  return !new Set(["closed", "out_of_scope", "retired", "resolved", "superseded", "not_applicable"]).has(status);
}

function lifecycleCoverageRecordIsActive(identifier, body) {
  const status = body.match(/^- status: (\S+)$/mu)?.[1]?.toLowerCase() ?? null;
  if (identifier.startsWith("R-")) return status === "in_scope";
  if (identifier.startsWith("AC-")) return status === "active";
  return authorityRecordIsActive(body);
}

function lifecycleAcceptanceVerifies(body, label) {
  const raw = field(body, "verifies", { required: false });
  if (raw === null) return [];
  const match = raw.match(/^\[((?:R-[0-9]{3})(?:, R-[0-9]{3})*)\]$/u);
  if (match === null) throw new ExecutionContractError(`${label} has malformed verifies relationship`);
  return match[1].split(", ");
}

async function authorityReferenceSets(workspace) {
  if (workspace.kind === "standalone") {
    const text = await fs.readFile(workspace.authorityPath, "utf8");
    const known = new Set(text.match(CANONICAL_AUTHORITY_REFERENCE_PATTERN) ?? []);
    const acceptance = new Set([...known].filter((value) => value.startsWith("AC-")));
    const requirements = new Set([...known].filter((value) => value.startsWith("R-")));
    return { known, active: new Set(known), required: acceptance.size !== 0 ? acceptance : requirements };
  }
  const projection = await lifecycleProjection(workspace);
  const records = projection.records.map(([id, body]) => ({ id, body })).filter(({ id }) => CANONICAL_AUTHORITY_REFERENCE.test(id));
  const known = new Set(records.map(({ id }) => id));
  const active = records.filter(({ id, body }) => lifecycleCoverageRecordIsActive(id, body));
  const acceptance = new Set(active.filter(({ id }) => id.startsWith("AC-")).map(({ id }) => id));
  const requirements = new Set(active.filter(({ id }) => id.startsWith("R-")).map(({ id }) => id));
  const requirementsCoveredByAcceptance = new Set(active
    .filter(({ id }) => id.startsWith("AC-"))
    .flatMap(({ id, body }) => lifecycleAcceptanceVerifies(body, `${id} verifies`)));
  const uncoveredRequirements = [...requirements].filter((id) => !requirementsCoveredByAcceptance.has(id));
  return {
    known,
    active: new Set(active.map(({ id }) => id)),
    required: new Set([...acceptance, ...uncoveredRequirements]),
  };
}

function referenceValue(body, name, expected, label) {
  const actual = field(body, name);
  if (actual !== `\`${expected}\``) throw new ExecutionContractError(`${label} has non-canonical ${name}`);
}

function throwLegacyExecutionContract(label, classification, reason, detail = "historical authority metadata cannot be invented") {
  const violation = Object.freeze({
    kind: "legacy-execution-contract",
    artifact: label,
    owner: "execution-contract-runtime",
    classification,
    repairability: "blocked",
    reason,
  });
  throw new ExecutionContractError(
    `legacy execution contract blocked in ${label}: ${reason}; ${detail}`,
    [label],
    [],
    violation,
  );
}

function parsedHistoricalPurpose(text, label) {
  try {
    return parsePurpose(text, label);
  } catch {
    return null;
  }
}

function historicalPrimaryH1(parsed) {
  return parsed?.body.match(/^# ([^\n]+)\n\n/u)?.[1] ?? null;
}

async function detectOfficialLifecycleRootExecution(workspace) {
  if (workspace.kind !== "lifecycle") return false;
  const planPath = path.join(workspace.specRoot, "plan.md");
  const tasksPath = path.join(workspace.specRoot, "tasks.md");
  const plansRoot = path.join(workspace.specRoot, "plans");
  const tasksRoot = path.join(workspace.specRoot, "tasks");
  const [planMetadata, tasksMetadata, plansMetadata, tasksDirectoryMetadata] = await Promise.all([
    lstatOrNull(planPath), lstatOrNull(tasksPath), lstatOrNull(plansRoot), lstatOrNull(tasksRoot),
  ]);
  if (!planMetadata?.isFile() || planMetadata.isSymbolicLink() || planMetadata.nlink !== 1
    || !tasksMetadata?.isFile() || tasksMetadata.isSymbolicLink() || tasksMetadata.nlink !== 1
    || !plansMetadata?.isDirectory() || plansMetadata.isSymbolicLink()
    || !tasksDirectoryMetadata?.isDirectory() || tasksDirectoryMetadata.isSymbolicLink()) return false;

  const [plan, tasks] = await Promise.all([
    fs.readFile(planPath, "utf8").then((text) => parsedHistoricalPurpose(text, planPath)),
    fs.readFile(tasksPath, "utf8").then((text) => parsedHistoricalPurpose(text, tasksPath)),
  ]);
  if (plan === null || tasks === null
    || plan.header.get("owner") !== "stnl-spec-execution-manager"
    || plan.header.get("purpose") !== "Template for the compact index of all delivery phases."
    || historicalPrimaryH1(plan) !== "Delivery Plan Index"
    || !plan.body.includes("## Requirements Source\n\n```yaml\nrequirements_source: feature_spec.md\nexecution_workspace:")
    || !plan.body.includes("| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |\n|---|---|---|---|---|---|---|---|")
    || tasks.header.get("owner") !== "stnl-spec-execution-manager"
    || tasks.header.get("purpose") !== "Template for the cumulative compact index of detailed delivery task records."
    || historicalPrimaryH1(tasks) !== "Delivery Tasks Index"
    || !tasks.body.includes("| Done | Phase | Tasks | Detail | Tests | Validation | Result |\n|---|---|---|---|---|---|---|")) return false;

  const planRows = [...plan.body.matchAll(/^\| \[[ x]\] \| ([0-9]{2,}) - [^|]+ \|[^\n]*\| plans\/plan-\1\.md \| [^|]+ \|$/gmu)]
    .map((match) => match[1]);
  const taskRows = [...tasks.body.matchAll(/^\| \[[ x]\] \| ([0-9]{2,}) - [^|]+ \|[^\n]*\| tasks\/tasks-\1\.md \|[^\n]*\|$/gmu)]
    .map((match) => match[1]);
  if (planRows.length === 0 || taskRows.length === 0
    || planRows.length !== taskRows.length
    || planRows.some((identifier, index) => identifier !== taskRows[index])) return false;

  for (const identifier of planRows) {
    const detailedPlanPath = path.join(plansRoot, `plan-${identifier}.md`);
    const detailedTaskPath = path.join(tasksRoot, `tasks-${identifier}.md`);
    const [detailedPlanMetadata, detailedTaskMetadata] = await Promise.all([
      lstatOrNull(detailedPlanPath), lstatOrNull(detailedTaskPath),
    ]);
    if (!detailedPlanMetadata?.isFile() || detailedPlanMetadata.isSymbolicLink() || detailedPlanMetadata.nlink !== 1
      || !detailedTaskMetadata?.isFile() || detailedTaskMetadata.isSymbolicLink() || detailedTaskMetadata.nlink !== 1) return false;
    const [detailedPlan, detailedTask] = await Promise.all([
      fs.readFile(detailedPlanPath, "utf8").then((text) => parsedHistoricalPurpose(text, detailedPlanPath)),
      fs.readFile(detailedTaskPath, "utf8").then((text) => parsedHistoricalPurpose(text, detailedTaskPath)),
    ]);
    if (detailedPlan?.header.get("owner") !== "stnl-spec-execution-manager"
      || detailedPlan.header.get("purpose") !== "Template for detailed planning of one conservative delivery phase."
      || !new RegExp(`^Phase ${identifier} - \\S`, "u").test(historicalPrimaryH1(detailedPlan) ?? "")
      || detailedTask?.header.get("owner") !== "stnl-spec-execution-manager"
      || detailedTask.header.get("purpose") !== "Template for detailed delivery tasks and evidence of one phase."
      || !new RegExp(`^Phase ${identifier} Tasks - \\S`, "u").test(historicalPrimaryH1(detailedTask) ?? "")) return false;
  }
  return true;
}

async function rejectOfficialLifecycleRootExecution(workspace) {
  if (await detectOfficialLifecycleRootExecution(workspace)) {
    throwLegacyExecutionContract(
      workspace.specRoot,
      "structurally-incompatible",
      "official-lifecycle-root-execution-generation",
      "the official 98545e4 root-level execution producer is recognized but automatic migration is not authorized",
    );
  }
}

function exactSectionNames(body) {
  return [...body.matchAll(/^## ([^\n]+)$/gmu)].map((match) => match[1]);
}

function exactHistoricalPlannerHeader(header, expected) {
  return new Set(["draft", "ready"]).has(header.get("status"))
    && Object.entries(expected).every(([name, value]) => header.get(name) === value);
}

function isOfficial98545e4Plan(header, body) {
  return header.get("owner") === "stnl-spec-execution-manager"
    && header.get("purpose") === "Template for the compact index of all delivery phases."
    && body.match(/^# ([^\n]+)\n\n/u)?.[1] === "Delivery Plan Index"
    && exactSectionNames(body).join("\0") === "Requirements Source"
    && body.includes("```yaml\nrequirements_source: feature_spec.md\nexecution_workspace:")
    && body.includes("| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |\n|---|---|---|---|---|---|---|---|");
}

function isOfficialE45e41dSplitPlan(header, body, expectedSlice) {
  if (/^- Requirements authority:/mu.test(body) || /^- Plan revision:/mu.test(body)) return false;
  const primaryH1 = body.match(/^# ([^\n]+)\n\n/u)?.[1] ?? null;
  if (expectedSlice === null) {
    if (!exactHistoricalPlannerHeader(header, {
      purpose: "Template for compact global execution strategy and serial slice coverage.",
      read_when: "PLAN creates or REVIEW_PLAN checks the global execution plan.",
      do_not_read_when: "A selected detailed plan already supplies all necessary local context.",
      contains: "Requirements source, objective, strategy, approval state, serial slice order, dependencies, coverage, and detailed plan paths.",
      owner: "stnl-execution-planner",
      update_policy: "PLAN creates as draft; REVIEW_PLAN corrects and changes status to ready.",
    }) || primaryH1 !== "Execution Plan"
      || exactSectionNames(body).join("\0") !== GLOBAL_PLAN_SECTIONS.join("\0")) return false;
    const parsed = sections(body);
    const context = parsed.get("Global Context") ?? "";
    const order = parsed.get("Serial Slice Order") ?? "";
    const risks = parsed.get("Global Risks and Integration") ?? "";
    if (!/^- Requirements source: `[^`]+`\n- Objective: \S.*\n- Strategy: \S.*\n- Review state: (?:pending|approved)$/u.test(context)
      || !/^(?:- \S.*\n)+\n`tasks\.md` is the only global progress authority and does not exist until approved plans are materialized\.$/u.test(risks)) return false;
    try {
      const rows = canonicalTableRows(
        order,
        "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |",
        "|---|---|---|---|---|---|",
        "historical e45e41d Serial Slice Order",
      );
      return rows.every((line) => {
        const columns = line.split("|").slice(1, -1).map((column) => column.trim());
        const identifier = columns[0]?.match(/^([0-9]{2,}) - \S.*$/u)?.[1];
        return columns.length === 6 && identifier !== undefined && columns[5] === `plans/slice-${identifier}.md`;
      });
    } catch {
      return false;
    }
  }
  if (!exactHistoricalPlannerHeader(header, {
    purpose: "Template for one observable and testable serial delivery slice.",
    read_when: "PLAN creates or REVIEW_PLAN checks this detailed slice plan.",
    do_not_read_when: "Another slice is active and no concrete dependency requires this plan.",
    contains: "References, objective, observable result, scope, boundaries, dependencies, risks, strategy, expected tests, and completion criterion.",
    owner: "stnl-execution-planner",
    update_policy: "PLAN creates as draft; REVIEW_PLAN corrects and changes status to ready.",
  }) || !new RegExp(`^Slice ${expectedSlice.slice(6)} - \\S`, "u").test(primaryH1 ?? "")
    || exactSectionNames(body).join("\0") !== SLICE_PLAN_SECTIONS.join("\0")) return false;
  const references = sections(body).get("References") ?? "";
  return new RegExp(
    `^- Slice: ${expectedSlice.slice(6)}\\n`
      + "- Requirements source: `[^`]+`\\n"
      + "- Global plan: `\\.\\./plan\\.md`\\n"
      + "- Review state: (?:pending|approved)$",
    "u",
  ).test(references);
}

function parsePlan(text, label, expectedSlice = null, references = {}) {
  const { header, body } = parsePurpose(text, label);
  if (isOfficial98545e4Plan(header, body)) {
    throwLegacyExecutionContract(label, "structurally-incompatible", "official-phase-index-generation");
  }
  if (isOfficialE45e41dSplitPlan(header, body, expectedSlice)) {
    throwLegacyExecutionContract(label, "semantically-incomplete", "known-split-plan-before-authority-fields");
  }
  if (header.get("owner") !== "stnl-execution-planner") throw new ExecutionContractError(`${label} has the wrong File Purpose Header owner`);
  const h1 = body.match(/^# ([^\n]+)\n\n/u)?.[1];
  if (expectedSlice === null ? h1 !== "Execution Plan" : !new RegExp(`^Slice ${expectedSlice.slice(6)} - \\S.*$`, "u").test(h1 ?? "")) {
    throw new ExecutionContractError(`${label} has a non-canonical primary heading`);
  }
  const parsedSections = sections(body);
  requireCanonicalSections(parsedSections, expectedSlice === null ? GLOBAL_PLAN_SECTIONS : SLICE_PLAN_SECTIONS, label);
  const authoritySection = parsedSections.get(expectedSlice === null ? "Global Context" : "References");
  if (authoritySection === undefined) throw new ExecutionContractError(`${label} is missing its authority section`);
  const state = authorityFields(authoritySection, label);
  if (references.requirementsSource !== undefined) referenceValue(authoritySection, "Requirements source", references.requirementsSource, label);
  if (expectedSlice !== null) referenceValue(authoritySection, "Global plan", "../plan.md", label);
  if (header.get("status") !== "ready" && header.get("status") !== "draft") throw new ExecutionContractError(`${label} has invalid status`);
  const reviewState = field(authoritySection, "Review state");
  if ((header.get("status") === "ready" && reviewState !== "approved")
    || (header.get("status") === "draft" && reviewState !== "pending")) {
    throw new ExecutionContractError(`${label} status and Review state disagree`);
  }
  if (expectedSlice !== null) {
    const declared = field(body, "Slice");
    if (declared !== expectedSlice.slice("slice-".length)) throw new ExecutionContractError(`${label} declares slice ${declared}, expected ${expectedSlice}`);
  }
  const revisionMode = field(body, "Revision mode", { required: false });
  if (revisionMode !== null && !new Set(["pristine-replacement", "append-only-extension"]).has(revisionMode)) {
    throw new ExecutionContractError(`${label} has invalid Revision mode`);
  }
  const replanReason = field(body, "Replan reason", { required: false });
  const supersedesValue = field(body, "Supersedes open slices", { required: false });
  if (expectedSlice !== null && (revisionMode !== null || replanReason !== null || supersedesValue !== null)) {
    throw new ExecutionContractError(`${label} contains global REPLAN fields`);
  }
  if (revisionMode === null) {
    if (replanReason !== null || supersedesValue !== null) throw new ExecutionContractError(`${label} has incomplete REPLAN fields`);
    return { ...state, body, sections: parsedSections, status: header.get("status"), reviewState, revisionMode, replanReason: null, supersessionMappings: [] };
  }
  requireNonPlaceholder(replanReason, `${label} Replan reason`);
  if (supersedesValue === null) throw new ExecutionContractError(`${label} is missing Supersedes open slices`);
  const supersessionMappings = [];
  if (supersedesValue !== "none") {
    for (const value of supersedesValue.split(", ")) {
      const mapping = value.match(/^(slice-[0-9]{2,}) -> (slice-[0-9]{2,})$/u);
      if (mapping === null) throw new ExecutionContractError(`${label} has malformed Supersedes open slices`);
      supersessionMappings.push({ source: mapping[1], target: mapping[2] });
    }
    if (new Set(supersessionMappings.map(({ source }) => source)).size !== supersessionMappings.length
      || new Set(supersessionMappings.map(({ target }) => target)).size !== supersessionMappings.length) {
      throw new ExecutionContractError(`${label} has duplicate supersession mappings`);
    }
  }
  return { ...state, body, sections: parsedSections, status: header.get("status"), reviewState, revisionMode, replanReason, supersessionMappings };
}

function operationRecords(section, prefix, { statusValues = null } = {}) {
  if (section === "- none") return [];
  if (/<[^>\n]+>/u.test(section)) throw new ExecutionContractError(`${prefix} section contains template placeholder content`);
  const pattern = new RegExp(`^### (${prefix}-([0-9]{2,}))$`, "gmu");
  const matches = [...section.matchAll(pattern)];
  if (matches.length === 0) throw new ExecutionContractError(`${prefix} section contains content without canonical records`);
  const records = [];
  for (let index = 0; index < matches.length; index += 1) {
    const end = index + 1 < matches.length ? matches[index + 1].index : section.length;
    const recordBody = normalizeText(section.slice(matches[index].index + matches[index][0].length, end));
    const expected = index + 1;
    if (Number(matches[index][2]) !== expected) throw new ExecutionContractError(`${prefix} identifiers must be contiguous from 01`);
    const status = statusValues === null ? null : field(recordBody, "Status");
    if (statusValues !== null && !statusValues.has(status)) throw new ExecutionContractError(`${matches[index][1]} has invalid Status ${status}`);
    records.push({ id: matches[index][1], body: recordBody, status });
  }
  return records;
}

function requireNonPlaceholder(value, label) {
  if (value === null || value.length === 0 || /^(?:none|pending|n\/a|not_available)$/iu.test(value) || /<[^>\n]+>/u.test(value)) {
    throw new ExecutionContractError(`${label} must be objective non-placeholder content`);
  }
  return value;
}

function requirePresentValue(value, label) {
  if (value === null || value.length === 0 || /^(?:pending|n\/a)$/iu.test(value) || /<[^>\n]+>/u.test(value)) {
    throw new ExecutionContractError(`${label} must contain a persisted value`);
  }
  return value;
}

function requireList(body, name, label) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marker = new RegExp(`^- ${escaped}:$`, "gmu");
  const matches = [...body.matchAll(marker)];
  if (matches.length !== 1) throw new ExecutionContractError(`${label} must contain exactly one ${name} list`);
  const tail = body.slice(matches[0].index + matches[0][0].length);
  const nextField = tail.search(/^-[ ]/mu);
  const listBody = nextField < 0 ? tail : tail.slice(0, nextField);
  const values = [...listBody.matchAll(/^  - (\S.*)$/gmu)].map((match) => match[1].trim());
  if (values.length === 0 || values.some((value) => /<[^>\n]+>/u.test(value))) {
    throw new ExecutionContractError(`${label} has an empty or placeholder ${name} list`);
  }
  return values;
}

function requireCommands(record, { permitNone = false, requireZero = false } = {}) {
  const markers = [...record.body.matchAll(/^- Commands:(?:[ \t]+(.*))?$/gmu)];
  if (markers.length !== 1) throw new ExecutionContractError(`${record.id} must contain exactly one Commands field`);
  const tail = record.body.slice(markers[0].index + markers[0][0].length);
  const nextField = tail.search(/^- [^:\n]+:/mu);
  const block = (nextField < 0 ? tail : tail.slice(0, nextField)).replace(/^\n/u, "").trimEnd();
  const inline = markers[0][1]?.trim() ?? null;
  if (inline !== null) {
    if (!permitNone || inline !== "none" || block.length !== 0) throw new ExecutionContractError(`${record.id} has invalid Commands`);
    return [];
  }
  const lines = block.split("\n").filter((line) => line.length !== 0);
  const commands = lines.map((line) => {
    const match = line.match(/^  - `([^`]+)` \| exit:([-]?[0-9]+)$/u);
    if (match === null) throw new ExecutionContractError(`${record.id} has malformed Commands`);
    return Object.freeze({ command: match[1], exit: Number(match[2]) });
  });
  if (commands.length === 0) throw new ExecutionContractError(`${record.id} has no numeric command evidence`);
  if (requireZero && commands.some((entry) => entry.exit !== 0)) throw new ExecutionContractError(`${record.id} PASS commands must exit zero`);
  return commands;
}

function blockerRecords(section, kind) {
  const records = operationRecords(section, kind);
  const ids = new Set(records.map((record) => record.id));
  for (const record of records) {
    record.severity = field(record.body, "Severity");
    record.state = field(record.body, "State");
    record.origin = field(record.body, "Origin");
    if (!new Set(["blocking", "advisory"]).has(record.severity)) throw new ExecutionContractError(`${record.id} has invalid Severity`);
    if (!new Set(["active", "resolved", "superseded"]).has(record.state)) throw new ExecutionContractError(`${record.id} has invalid State`);
    const requiredFields = kind === "finding"
      ? ["Problem", "Evidence", "Impact", "Related authority", "Expected correction"]
      : ["Problem", "Evidence", "Required authority operation"];
    for (const required of requiredFields) field(record.body, required);
    if (kind === "divergence") {
      // Legacy records require authority by contract. Only a divergence born
      // observational can be disposed as independent external quality debt.
      record.kind = field(record.body, "Kind", { required: false }) ?? "authority";
      record.requiredAuthorityOperation = field(record.body, "Required authority operation");
      if (!["observational", "authority", "structural", "required"].includes(record.kind)) throw new ExecutionContractError(`${record.id} has invalid divergence Kind`);
      const operations = record.kind === "observational" ? ["none"] : ["RESUME", "REPLAN"];
      if (!operations.includes(record.requiredAuthorityOperation)) throw new ExecutionContractError(`${record.id} has an invalid Required authority operation for its Kind`);
    }
    const resolutionValue = field(record.body, "Resolution", { required: false });
    const supersededValue = field(record.body, "Superseded by", { required: false });
    if (record.state === "active" && (resolutionValue !== null || supersededValue !== null)) {
      throw new ExecutionContractError(`${record.id} active state cannot contain resolution fields`);
    }
    if (record.state === "resolved") {
      const resolution = field(record.body, "Resolution");
      if (/^(?:none|pending|n\/a)$/iu.test(resolution)) throw new ExecutionContractError(`${record.id} has placeholder Resolution`);
      if (supersededValue !== null) throw new ExecutionContractError(`${record.id} resolved state cannot contain Superseded by`);
      if (kind === "divergence" && record.severity === "blocking") {
        const owner = resolution.match(/^plan revision ([1-9][0-9]*) committed recovery (slice-[0-9]{2,})$/u);
        const revalidated = resolution.match(/^(attempt-[0-9]{2,}|implementation-check-[0-9]{2,}|findings-check-[0-9]{2,}) revalidated: \S.+$/u);
        if (owner === null && revalidated === null) throw new ExecutionContractError(`${record.id} blocking divergence Resolution must name its committed plan revision and recovery slice or a revalidation record`);
        if (owner !== null) {
          record.resolutionRevision = Number(owner[1]);
          record.resolutionSlice = owner[2];
        } else record.revalidationRecord = revalidated[1];
      }
    }
    if (record.state === "superseded") {
      const replacement = field(record.body, "Superseded by");
      const currentNumber = Number(record.id.slice(record.id.lastIndexOf("-") + 1));
      const replacementNumber = Number(replacement.slice(replacement.lastIndexOf("-") + 1));
      if (!ids.has(replacement) || replacementNumber <= currentNumber) throw new ExecutionContractError(`${record.id} has invalid Superseded by`);
      if (resolutionValue !== null) throw new ExecutionContractError(`${record.id} superseded state cannot contain Resolution`);
    }
  }
  return records;
}

// Gate observations are append-only evidence inside existing checks/attempts. The
// independent runner supplies causality; the parser enforces the decision boundary.
const SUCCESS_RESULTS = new Set(["PASS", "ACCEPTED"]);
const SUCCESS_CHECKS = new Set(["TESTS_PASS", "TESTS_ACCEPTED", "TESTS_NOT_APPLICABLE"]);
const NON_BLOCKING_GATES = new Set(["resolved", "non_blocking", "bypassed"]);
const GATE_KEYS = new Set(["id", "command", "kind", "scope", "causality", "state", "problem", "evidence", "diagnostic", "correction", "correctionEvidence", "revalidates", "snapshot", "bypass"]);

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    throw new ExecutionContractError(`${label} has missing or unknown fields`);
  }
}

const EVIDENCE_PROVENANCE_KEYS = new Set([
  "version", "evidenceId", "priorEvidenceId", "state", "classification", "conclusion",
  "operation", "slice", "round", "workspace", "inputs", "subjects", "commands", "replay",
]);
const EVIDENCE_PROVENANCE_BLOCKED_KEYS = new Set([...EVIDENCE_PROVENANCE_KEYS, "blocker"]);
const EVIDENCE_BLOCKER_KEYS = new Set(["kind", "stage", "code", "message", "target"]);
const EVIDENCE_WORKSPACE_KEYS = new Set([
  "kind", "workspaceId", "cwd", "executionRoot", "liveExecutionFingerprintBefore",
  "liveExecutionFingerprintAfter", "liveWorkspaceFingerprintBefore", "liveWorkspaceFingerprintAfter",
  "isolatedExecutionFingerprintBefore", "isolatedExecutionFingerprintAfter", "cleanup", "sideEffects",
]);
const EVIDENCE_INPUT_KEYS = new Set([
  "requirementsAuthority", "planRevision", "head", "sourceFingerprint", "manifestFingerprint",
  "baselineFingerprint", "changedScopeFingerprint", "executionFingerprint",
]);
const EVIDENCE_SUBJECT_KEYS = new Set(["path", "expected"]);
const EVIDENCE_COMMAND_KEYS = new Set([
  "display", "argv", "cwd", "writePaths", "envFingerprint", "executableFingerprint", "timeoutMs", "exit",
  "stdoutFingerprint", "stderrFingerprint",
]);
const EVIDENCE_REPLAY_KEYS = new Set([
  "originalEvidenceId", "originalFingerprint", "currentFingerprint", "equivalent", "mismatches",
]);
const EVIDENCE_REPLAY_COMPONENTS = new Set([
  "operation", "slice", "round", "cwd", "executionRoot", "requirementsAuthority", "planRevision",
  "head", "sourceFingerprint", "manifestFingerprint", "baselineFingerprint", "changedScopeFingerprint",
  "commandsFingerprint", "executionFingerprint",
]);

function deterministicDigest(domain, value) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    }
    return input;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical([domain, value]))).digest("hex")}`;
}

function canonicalEvidenceMaterial(provenance) {
  const { evidenceId: _evidenceId, ...material } = provenance;
  return material;
}

export function validationEvidenceIdentity(provenance) {
  return deterministicDigest("stnl-validation-evidence-v1", canonicalEvidenceMaterial(provenance));
}

function validateProjectRelativePath(value, label) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.endsWith("/") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === ".." || value.startsWith("../")) {
    throw new ExecutionContractError(`${label} is not a normalized project-relative path: ${value}`);
  }
  return value;
}

function evidenceSubjectFingerprint(subjects) {
  return deterministicDigest("stnl-validation-subject-manifest-v1", subjects);
}

function changedScopeFingerprint(subjects) {
  return deterministicDigest("stnl-validation-changed-scope-v1", subjects.map((entry) => entry.path));
}

function evidenceExecutionFingerprint(provenance) {
  const commands = provenance.commands.map(({ stdoutFingerprint: _stdout, stderrFingerprint: _stderr, exit: _exit, ...command }) => command);
  const inputs = { ...provenance.inputs };
  delete inputs.executionFingerprint;
  return deterministicDigest("stnl-validation-execution-v1", {
    operation: provenance.operation,
    slice: provenance.slice,
    round: provenance.round,
    cwd: provenance.workspace.cwd,
    executionRoot: provenance.workspace.executionRoot,
    subjects: provenance.subjects,
    commands,
    inputs,
  });
}

function parseEvidenceProvenance(record, authority, { operation, round, required = false }) {
  const raw = field(record.body, "Evidence provenance", { required: false });
  if (raw === null) {
    if (required) throw new ExecutionContractError(`${record.id} v1 validation evidence requires structured provenance`);
    return null;
  }
  let provenance;
  try { provenance = JSON.parse(raw); } catch { throw new ExecutionContractError(`${record.id} Evidence provenance must be inline JSON`); }
  exactObject(
    provenance,
    Object.hasOwn(provenance, "blocker") ? EVIDENCE_PROVENANCE_BLOCKED_KEYS : EVIDENCE_PROVENANCE_KEYS,
    `${record.id} Evidence provenance`,
  );
  if (provenance.version !== 1 || !VALIDATION_EVIDENCE_STATES.has(provenance.state)
    || !VALIDATION_EVIDENCE_CLASSIFICATIONS.has(provenance.classification)
    || !VALIDATION_CONCLUSIONS.has(provenance.conclusion)) {
    throw new ExecutionContractError(`${record.id} Evidence provenance has an unsupported version or lifecycle value`);
  }
  if (!VALIDATION_EVIDENCE_LIFECYCLE.get(provenance.state)?.get(provenance.classification)?.has(provenance.conclusion)) {
    throw new ExecutionContractError(`${record.id} Evidence provenance has an illegal lifecycle combination`);
  }
  if (provenance.operation !== operation || provenance.slice !== authority.slice || provenance.round !== round) {
    throw new ExecutionContractError(`${record.id} Evidence provenance origin disagrees with its record`);
  }
  if (provenance.priorEvidenceId !== null && (typeof provenance.priorEvidenceId !== "string" || !CURRENT_AUTHORITY.test(provenance.priorEvidenceId))) {
    throw new ExecutionContractError(`${record.id} Evidence provenance priorEvidenceId is malformed`);
  }
  const infrastructureBlocked = provenance.classification === "INFRASTRUCTURE_BLOCKED";
  if (infrastructureBlocked) {
    exactObject(provenance.blocker, EVIDENCE_BLOCKER_KEYS, `${record.id} Evidence blocker`);
    if (!new Set(["infrastructure", "source-isolation"]).has(provenance.blocker.kind)
      || !new Set(["sandbox-preflight", "source-admission", "source-copy"]).has(provenance.blocker.stage)
      || typeof provenance.blocker.code !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(provenance.blocker.code)
      || typeof provenance.blocker.message !== "string" || provenance.blocker.message.length === 0
      || (provenance.blocker.target !== null
        && validateProjectRelativePath(provenance.blocker.target, `${record.id} Evidence blocker target`) !== provenance.blocker.target)) {
      throw new ExecutionContractError(`${record.id} Evidence blocker is malformed`);
    }
  } else if (Object.hasOwn(provenance, "blocker")) {
    throw new ExecutionContractError(`${record.id} non-infrastructure evidence cannot contain a blocker`);
  }
  exactObject(provenance.workspace, EVIDENCE_WORKSPACE_KEYS, `${record.id} Evidence workspace`);
  const workspace = provenance.workspace;
  if (infrastructureBlocked) {
    const unavailable = deterministicDigest("stnl-validation-isolated-not-created-v1", []);
    const expectedCleanup = provenance.blocker.stage === "source-copy" ? "clean" : "not-required";
    if (workspace.kind !== "pre-check" || workspace.cleanup !== expectedCleanup
      || workspace.isolatedExecutionFingerprintBefore !== unavailable
      || workspace.isolatedExecutionFingerprintAfter !== unavailable
      || !Array.isArray(workspace.sideEffects) || workspace.sideEffects.length !== 0
      || workspace.liveExecutionFingerprintBefore !== workspace.liveExecutionFingerprintAfter
      || workspace.liveWorkspaceFingerprintBefore !== workspace.liveWorkspaceFingerprintAfter) {
      throw new ExecutionContractError(`${record.id} infrastructure blocker has invalid pre-check workspace evidence`);
    }
  } else if (workspace.kind !== "isolated-copy" || workspace.cleanup !== "clean") {
    if (provenance.state !== "INVALID" || provenance.classification !== "VALIDATION_SIDE_EFFECT") {
      throw new ExecutionContractError(`${record.id} non-isolated or unclean validation workspace must be invalid`);
    }
  }
  for (const [value, label] of [
    [workspace.workspaceId, "workspaceId"],
    [workspace.liveExecutionFingerprintBefore, "live execution before fingerprint"],
    [workspace.liveExecutionFingerprintAfter, "live execution after fingerprint"],
    [workspace.liveWorkspaceFingerprintBefore, "live workspace before fingerprint"],
    [workspace.liveWorkspaceFingerprintAfter, "live workspace after fingerprint"],
    [workspace.isolatedExecutionFingerprintBefore, "isolated execution before fingerprint"],
    [workspace.isolatedExecutionFingerprintAfter, "isolated execution after fingerprint"],
  ]) {
    if (typeof value !== "string" || !CURRENT_AUTHORITY.test(value)) throw new ExecutionContractError(`${record.id} ${label} is malformed`);
  }
  validateProjectRelativePath(workspace.cwd, `${record.id} workspace cwd`);
  validateProjectRelativePath(workspace.executionRoot, `${record.id} workspace execution root`);
  if (!Array.isArray(workspace.sideEffects) || workspace.sideEffects.some((entry) => typeof entry !== "string" || entry.length === 0)
    || new Set(workspace.sideEffects).size !== workspace.sideEffects.length
    || workspace.sideEffects.some((entry, index) => index > 0 && entry.localeCompare(workspace.sideEffects[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${record.id} Evidence workspace sideEffects must be a unique ordered array`);
  }

  exactObject(provenance.inputs, EVIDENCE_INPUT_KEYS, `${record.id} Evidence inputs`);
  const inputs = provenance.inputs;
  if (inputs.requirementsAuthority !== `sha256:${authority.fingerprint}` || inputs.planRevision !== authority.revision) {
    throw new ExecutionContractError(`${record.id} Evidence inputs are stale relative to current authority`);
  }
  if (inputs.head !== "not_available" && (typeof inputs.head !== "string" || !/^[0-9a-f]{40,64}$/u.test(inputs.head))) {
    throw new ExecutionContractError(`${record.id} Evidence HEAD is malformed`);
  }
  if (field(record.body, "HEAD") !== inputs.head) {
    throw new ExecutionContractError(`${record.id} HEAD disagrees with Evidence provenance`);
  }
  for (const name of ["sourceFingerprint", "manifestFingerprint", "changedScopeFingerprint", "executionFingerprint"]) {
    if (typeof inputs[name] !== "string" || !CURRENT_AUTHORITY.test(inputs[name])) throw new ExecutionContractError(`${record.id} Evidence ${name} is malformed`);
  }
  if (inputs.baselineFingerprint !== null && (typeof inputs.baselineFingerprint !== "string" || !CURRENT_AUTHORITY.test(inputs.baselineFingerprint))) {
    throw new ExecutionContractError(`${record.id} Evidence baselineFingerprint is malformed`);
  }
  if (infrastructureBlocked && inputs.sourceFingerprint !== deterministicDigest(
    "stnl-validation-source-precheck-v1",
    { liveWorkspaceBefore: workspace.liveWorkspaceFingerprintBefore, blocker: provenance.blocker },
  )) {
    throw new ExecutionContractError(`${record.id} infrastructure blocker source fingerprint is inconsistent`);
  }

  if (!Array.isArray(provenance.subjects)) throw new ExecutionContractError(`${record.id} Evidence subjects must be an array`);
  const subjectPaths = [];
  for (const subject of provenance.subjects) {
    exactObject(subject, EVIDENCE_SUBJECT_KEYS, `${record.id} Evidence subject`);
    subject.path = validateRelativeEvidencePath(subject.path, `${record.id} Evidence subject path`);
    if (typeof subject.expected !== "string" || (subject.expected !== "REMOVED" && !CURRENT_AUTHORITY.test(subject.expected))) {
      throw new ExecutionContractError(`${record.id} Evidence subject has malformed expected state`);
    }
    subjectPaths.push(subject.path);
  }
  if (new Set(subjectPaths).size !== subjectPaths.length
    || subjectPaths.some((entry, index) => index > 0 && entry.localeCompare(subjectPaths[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${record.id} Evidence subjects must preserve unique file identity in lexical order`);
  }
  if (inputs.manifestFingerprint !== evidenceSubjectFingerprint(provenance.subjects)
    || inputs.changedScopeFingerprint !== changedScopeFingerprint(provenance.subjects)) {
    throw new ExecutionContractError(`${record.id} Evidence subject fingerprints do not match the persisted subjects`);
  }

  if (!Array.isArray(provenance.commands)) throw new ExecutionContractError(`${record.id} Evidence commands must be an array`);
  for (const command of provenance.commands) {
    exactObject(command, EVIDENCE_COMMAND_KEYS, `${record.id} Evidence command`);
    if (typeof command.display !== "string" || command.display.length === 0 || !Array.isArray(command.argv)
      || command.argv.length === 0 || command.argv.some((entry) => typeof entry !== "string")
      || !Array.isArray(command.writePaths)
      || command.writePaths.some((entry) => validateProjectRelativePath(entry, `${record.id} Evidence command write path`) !== entry)
      || new Set(command.writePaths).size !== command.writePaths.length
      || command.writePaths.some((entry, index) => index > 0 && entry.localeCompare(command.writePaths[index - 1], "en") <= 0)
      || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0 || !Number.isSafeInteger(command.exit)) {
      throw new ExecutionContractError(`${record.id} Evidence command is malformed`);
    }
    validateProjectRelativePath(command.cwd, `${record.id} Evidence command cwd`);
    for (const name of ["envFingerprint", "executableFingerprint", "stdoutFingerprint", "stderrFingerprint"]) {
      if (typeof command[name] !== "string" || !CURRENT_AUTHORITY.test(command[name])) throw new ExecutionContractError(`${record.id} Evidence command ${name} is malformed`);
    }
  }
  if (record.commands.length !== provenance.commands.length || record.commands.some((command, index) => (
    command.command !== provenance.commands[index].display || command.exit !== provenance.commands[index].exit
  ))) throw new ExecutionContractError(`${record.id} Commands disagree with Evidence provenance`);
  if (infrastructureBlocked && (provenance.subjects.length !== 0 || provenance.commands.length !== 0 || provenance.replay !== null)) {
    throw new ExecutionContractError(`${record.id} infrastructure blocker cannot claim subjects, commands, or replay`);
  }
  if (inputs.executionFingerprint !== evidenceExecutionFingerprint(provenance)
    || workspace.workspaceId !== inputs.executionFingerprint) {
    throw new ExecutionContractError(`${record.id} Evidence execution identity is inconsistent`);
  }

  if (provenance.replay !== null) {
    exactObject(provenance.replay, EVIDENCE_REPLAY_KEYS, `${record.id} Evidence replay`);
    const replay = provenance.replay;
    if (typeof replay.originalEvidenceId !== "string" || !CURRENT_AUTHORITY.test(replay.originalEvidenceId)
      || typeof replay.originalFingerprint !== "string" || !CURRENT_AUTHORITY.test(replay.originalFingerprint)
      || replay.currentFingerprint !== inputs.executionFingerprint || typeof replay.equivalent !== "boolean"
      || !Array.isArray(replay.mismatches)
      || replay.mismatches.some((entry) => typeof entry !== "string" || !EVIDENCE_REPLAY_COMPONENTS.has(entry))
      || new Set(replay.mismatches).size !== replay.mismatches.length
      || replay.mismatches.some((entry, index) => index > 0 && entry.localeCompare(replay.mismatches[index - 1], "en") <= 0)) {
      throw new ExecutionContractError(`${record.id} Evidence replay is malformed`);
    }
    if (replay.equivalent !== (replay.originalFingerprint === replay.currentFingerprint)
      || replay.equivalent !== (replay.mismatches.length === 0)) {
      throw new ExecutionContractError(`${record.id} Evidence replay equivalence is internally inconsistent`);
    }
    if (!replay.equivalent && (provenance.state !== "INVALID"
      || !new Set(["INVALID_REPLAY", "VALIDATION_SIDE_EFFECT"]).has(provenance.classification)
      || provenance.conclusion !== "NONE")) {
      throw new ExecutionContractError(`${record.id} invalid replay cannot support a validation conclusion`);
    }
  } else if (provenance.classification === "INVALID_REPLAY" || provenance.conclusion === "CODE_REGRESSION") {
    throw new ExecutionContractError(`${record.id} code regression requires an explicit replay equivalence record`);
  }

  const sideEffect = workspace.sideEffects.length !== 0
    || workspace.liveExecutionFingerprintBefore !== workspace.liveExecutionFingerprintAfter
    || workspace.liveWorkspaceFingerprintBefore !== workspace.liveWorkspaceFingerprintAfter
    || workspace.isolatedExecutionFingerprintBefore !== workspace.isolatedExecutionFingerprintAfter
    || (!infrastructureBlocked && workspace.cleanup !== "clean");
  if (sideEffect !== (provenance.classification === "VALIDATION_SIDE_EFFECT")) {
    throw new ExecutionContractError(`${record.id} validation side-effect classification disagrees with workspace evidence`);
  }
  if (sideEffect && (provenance.state !== "INVALID" || provenance.conclusion !== "NONE")) {
    throw new ExecutionContractError(`${record.id} validation side effect must invalidate the evidence`);
  }
  if (provenance.state === "VERIFIED" && provenance.classification !== "NONE") {
    throw new ExecutionContractError(`${record.id} verified evidence cannot retain an invalid classification`);
  }
  if (provenance.state === "INVALID" && record.status !== "BLOCKED") {
    throw new ExecutionContractError(`${record.id} invalid evidence can only produce BLOCKED`);
  }
  if (["PASS", "ACCEPTED", "NEEDS_FIX", "TESTS_PASS", "TESTS_ACCEPTED", "TESTS_FAIL", "TESTS_NOT_APPLICABLE"].includes(record.status)
    && provenance.state !== "VERIFIED") {
    throw new ExecutionContractError(`${record.id} material conclusion requires VERIFIED evidence`);
  }
  if (["PASS", "ACCEPTED", "TESTS_PASS", "TESTS_ACCEPTED", "TESTS_NOT_APPLICABLE"].includes(record.status)
    && provenance.conclusion !== "NONE") {
    throw new ExecutionContractError(`${record.id} successful or non-applicable evidence cannot assert a finding`);
  }
  if (["NEEDS_FIX", "TESTS_FAIL"].includes(record.status) && provenance.conclusion === "NONE") {
    throw new ExecutionContractError(`${record.id} failing evidence requires a structured conclusion`);
  }
  if (provenance.evidenceId !== validationEvidenceIdentity(provenance)) {
    throw new ExecutionContractError(`${record.id} Evidence identity does not match its provenance`);
  }
  return Object.freeze(provenance);
}

export function qualityGateIdentity(gate, authority) {
  // Observation timestamps, prose and unrelated working-tree changes are not an
  // identity. Diagnostic content and the authority/obligation boundary are.
  return `sha256:${createHash("sha256").update(JSON.stringify([
    "stnl-quality-gate-v1", authority.fingerprint, authority.revision, authority.slice,
    gate.id, gate.command, gate.kind, gate.scope, gate.causality,
    gate.diagnostic, gate.correction,
  ])).digest("hex")}`;
}

export function evaluateQualityGate(gate, authority) {
  exactObject(gate, GATE_KEYS, "Gate assessment");
  for (const key of ["id", "problem", "evidence", "correctionEvidence"]) {
    if (typeof gate[key] !== "string") throw new ExecutionContractError(`Gate ${key} must be text`);
    requireNonPlaceholder(gate[key], `Gate ${key}`);
  }
  if (!/^gate-[0-9]{2,}$/u.test(gate.id) || (typeof gate.diagnostic !== "string" || !CURRENT_AUTHORITY.test(gate.diagnostic))) throw new ExecutionContractError("Gate identity is malformed");
  for (const [key, values] of Object.entries({
    kind: ["quality", "requirement", "structural"], scope: ["in_scope", "out_of_scope"],
    causality: ["independent", "caused_by_slice", "required_by_slice", "unknown"],
    state: ["present", "absent"], correction: ["in_scope", "authority_change", "unknown"],
  })) if (!values.includes(gate[key])) throw new ExecutionContractError(`Gate ${key} is invalid`);
  if (gate.command !== null && (typeof gate.command !== "string" || gate.command.length === 0)) throw new ExecutionContractError("Gate command is invalid");
  if (gate.revalidates !== null && (typeof gate.revalidates !== "string" || !/^(?:(?:attempt|implementation-check|findings-check)-[0-9]{2,}\/gate-[0-9]{2,}|finding-[0-9]{2,}|divergence-[0-9]{2,})$/u.test(gate.revalidates))) throw new ExecutionContractError("Gate revalidates is invalid");
  if (!Array.isArray(gate.snapshot)) throw new ExecutionContractError("Gate snapshot must be an array");
  const paths = [];
  for (const entry of gate.snapshot) {
    exactObject(entry, new Set(["path", "expected"]), "Gate snapshot");
    if (typeof entry.path !== "string" || typeof entry.expected !== "string" || (entry.expected !== "REMOVED" && !CURRENT_AUTHORITY.test(entry.expected))) throw new ExecutionContractError("Gate snapshot is malformed");
    validateRelativeEvidencePath(entry.path, "Gate snapshot path");
    paths.push(entry.path);
  }
  if (new Set(paths).size !== paths.length || paths.some((v, i) => i > 0 && v.localeCompare(paths[i - 1], "en") <= 0)) throw new ExecutionContractError("Gate snapshot paths must be unique and ordered");
  let decision;
  if (gate.state === "absent") decision = "resolved";
  else if (gate.kind === "structural") decision = "blocking";
  else if (gate.kind === "quality" && gate.scope === "out_of_scope" && gate.causality === "independent") decision = "non_blocking";
  else if (gate.causality === "unknown") decision = "investigate";
  else if (gate.correction === "authority_change" && ["caused_by_slice", "required_by_slice"].includes(gate.causality)) decision = "replan";
  else decision = "blocking";
  if (decision === "replan" && gate.snapshot.length === 0) throw new ExecutionContractError("REPLAN requires a current causal snapshot");
  const identity = qualityGateIdentity(gate, authority);
  if (gate.bypass !== null) {
    exactObject(gate.bypass, new Set(["target", "operator", "reason", "authorization"]), "Gate bypass");
    for (const key of ["operator", "reason", "authorization"]) {
      if (typeof gate.bypass[key] !== "string") throw new ExecutionContractError(`Bypass ${key} must be text`);
      requireNonPlaceholder(gate.bypass[key], `Bypass ${key}`);
    }
    // Referential integrity applies even when approval is only history. A
    // materially changed gate keeps old approval in its prior record only.
    if (gate.bypass.target !== identity) throw new ExecutionContractError("Gate bypass does not match this blocker and authority");
    if (gate.kind !== "quality" || gate.correction !== "in_scope"
      || ["required_by_slice", "unknown"].includes(gate.causality)) throw new ExecutionContractError("This gate cannot be bypassed");
    // Recovery wins: valid historical approval never changes the current result.
    if (!NON_BLOCKING_GATES.has(decision)) {
      if (decision !== "blocking") throw new ExecutionContractError("This gate cannot be bypassed");
      decision = "bypassed";
    }
  }
  return Object.freeze({ ...gate, identity, decision });
}

function parseGateAssessments(record, authority) {
  const raw = field(record.body, "Gate assessments", { required: false });
  if (raw === null) return [];
  let gates;
  try { gates = JSON.parse(raw); } catch { throw new ExecutionContractError(`${record.id} Gate assessments must be inline JSON`); }
  if (!Array.isArray(gates) || gates.length === 0) throw new ExecutionContractError(`${record.id} Gate assessments must be a nonempty array`);
  const evaluated = gates.map((gate) => evaluateQualityGate(gate, authority));
  if (new Set(evaluated.map((gate) => gate.id)).size !== evaluated.length) throw new ExecutionContractError(`${record.id} duplicate gate ID`);
  for (const gate of evaluated) if (gate.command !== null && !record.commands.some((entry) => entry.command === gate.command)) throw new ExecutionContractError(`${record.id} gate command has no recorded exit`);
  return evaluated;
}

function validateGateResult(record, authority) {
  record.gates = parseGateAssessments(record, authority);
  const success = SUCCESS_RESULTS.has(record.status) || ["TESTS_PASS", "TESTS_ACCEPTED"].includes(record.status);
  const accepted = ["ACCEPTED", "TESTS_ACCEPTED"].includes(record.status);
  if (["BLOCKED", "TESTS_FAIL", "NEEDS_FIX"].includes(record.status) && record.gates.length > 0
    && record.gates.every((gate) => NON_BLOCKING_GATES.has(gate.decision))) throw new ExecutionContractError(`${record.id} cannot block solely on non-blocking gate observations`);
  if (success) {
    if (record.gates.some((gate) => !NON_BLOCKING_GATES.has(gate.decision))) throw new ExecutionContractError(`${record.id} success retains a blocking or undetermined gate`);
    if (accepted !== record.gates.some((gate) => gate.decision === "bypassed")) throw new ExecutionContractError(`${record.id} bypass requires ACCEPTED, never PASS`);
    for (const entry of record.commands.filter((entry) => entry.exit !== 0)) {
      const gates = record.gates.filter((gate) => gate.command === entry.command);
      if (gates.length === 0 || gates.some((gate) => !["non_blocking", "bypassed"].includes(gate.decision))) throw new ExecutionContractError(`${record.id} successful validation commands must exit zero unless every failure has a non-blocking gate assessment`);
    }
    // No bypass can replace the mandatory evidence for the slice itself.
    if (!record.commands.some((entry) => entry.exit === 0)) throw new ExecutionContractError(`${record.id} lacks successful mandatory slice evidence`);
  }
}

const CHECK_FIELD_NAMES = new Set([
  "Gate assessments", "Evidence provenance", "Automatic check round", "Status", "HEAD", "Tested scope", "Tested state", "Fileless reason", "Discovery sources",
  "Discovery actions", "Verification types considered", "Commands", "Selected checks", "Selection rationale",
  "Coverage", "Failures", "Blockers", "Unexpected workspace effects", "Persistence summary",
  "Prior-round failure", "Correction applied", "Correction paths", "Updated scope", "In-slice rationale",
  "Findings cycle", "Finding IDs", "Findings verified", "Corrections covered", "Regressions",
  "Unsupported active findings", "Non-applicability rationale", "No verification-command confirmation",
]);
const FINDINGS_CHECK_ONLY_FIELD_NAMES = new Set([
  "Findings cycle", "Finding IDs", "Findings verified", "Corrections covered", "Regressions", "Unsupported active findings",
]);
const IMPLEMENTATION_CHECK_FIELD_NAMES = new Set(
  [...CHECK_FIELD_NAMES].filter((name) => !FINDINGS_CHECK_ONLY_FIELD_NAMES.has(name)),
);
const ATTEMPT_FIELD_NAMES = new Set([
  "Gate assessments", "Evidence provenance", "Type", "Status", "HEAD", "Verified scope", "Commands", "Evidence", "Finding references", "Finding dispositions",
  "Blockers", "Unexpected workspace effects", "Persistence summary",
]);

function exactFieldLines(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...String(body).matchAll(new RegExp(`^- ${escaped}:[ \\t]*(.*)$`, "gmu"))];
}

function parseCanonicalFindingIds(value, label, { allowNone = false, declaredFindingIds = null } = {}) {
  if (allowNone && value === "none") return [];
  if (!/^finding-[0-9]{2,}(?:, finding-[0-9]{2,})*$/u.test(value)) {
    throw new ExecutionContractError(`${label} has malformed Finding IDs`);
  }
  const identifiers = value.split(", ");
  if (new Set(identifiers).size !== identifiers.length) throw new ExecutionContractError(`${label} has duplicate Finding IDs`);
  if (identifiers.some((identifier, index) => index > 0 && identifier.localeCompare(identifiers[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${label} Finding IDs are not lexicographically ordered`);
  }
  if (declaredFindingIds !== null) {
    const undeclared = identifiers.find((identifier) => !declaredFindingIds.has(identifier));
    if (undeclared !== undefined) throw new ExecutionContractError(`${label} has undeclared Finding ID ${undeclared}`);
  }
  return identifiers;
}

function parseFindingDispositions(value, label) {
  if (value === "none") return new Map();
  if (!/^finding-[0-9]{2,}=(?:active|resolved|superseded)(?:, finding-[0-9]{2,}=(?:active|resolved|superseded))*$/u.test(value)) {
    throw new ExecutionContractError(`${label} has malformed Finding dispositions`);
  }
  const entries = value.split(", ").map((entry) => entry.split("="));
  const identifiers = entries.map(([identifier]) => identifier);
  if (new Set(identifiers).size !== identifiers.length) throw new ExecutionContractError(`${label} has duplicate finding dispositions`);
  if (identifiers.some((identifier, index) => index > 0 && identifier.localeCompare(identifiers[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${label} finding dispositions are not lexicographically ordered`);
  }
  return new Map(entries);
}

function scopedField(body, name, label) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const markers = [...String(body).matchAll(new RegExp(`^- ${escaped}:(?:[ \\t]+(.*))?$`, "gmu"))];
  if (markers.length !== 1) throw new ExecutionContractError(`${label} must contain exactly one ${name} field`);
  const tail = String(body).slice(markers[0].index + markers[0][0].length);
  const nextField = tail.search(/^- [^:\n]+:/mu);
  const block = (nextField < 0 ? tail : tail.slice(0, nextField)).replace(/^\n/u, "").trimEnd();
  return { inline: markers[0][1]?.trim() ?? null, block };
}

function validateNestedScoping(record, { allowTestedState = false } = {}) {
  let owner = null;
  for (const line of record.body.split("\n")) {
    if (line.length === 0) continue;
    const top = line.match(/^- ([^:\n]+):/u);
    if (top !== null) {
      owner = top[1];
      continue;
    }
    const command = /^  - `[^`]+` \| exit:[-]?[0-9]+$/u.test(line);
    const testedState = /^  - `[^`]+` \| (?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(line);
    if ((command && owner === "Commands") || (allowTestedState && testedState && owner === "Tested state")) continue;
    throw new ExecutionContractError(`${record.id} has unexpected nested or continuation content under ${owner ?? "no field"}`);
  }
}

function validateRecordFields(record, allowedFields) {
  const names = [...record.body.matchAll(/^- ([^:\n]+):/gmu)].map((match) => match[1]);
  const unexpected = names.find((name) => !allowedFields.has(name));
  if (unexpected !== undefined) throw new ExecutionContractError(`${record.id} has unknown field '${unexpected}'`);
}

function requireTestedState(record) {
  const structured = scopedField(record.body, "Tested state", record.id);
  if (structured.inline === "none" && structured.block.length === 0) {
    requireNonPlaceholder(field(record.body, "Fileless reason"), `${record.id} Fileless reason`);
    return [];
  }
  if (structured.inline !== null) throw new ExecutionContractError(`${record.id} Tested state must be a nested tuple list`);
  if (field(record.body, "Fileless reason", { required: false }) !== null) {
    throw new ExecutionContractError(`${record.id} Fileless reason is permitted only with Tested state: none`);
  }
  const lines = structured.block.split("\n").filter((line) => line.length !== 0);
  const entries = lines.map((line) => {
    const match = line.match(/^  - `([^`]+)` \| (sha256:([0-9a-f]{64})|REMOVED)$/u);
    if (match === null) throw new ExecutionContractError(`${record.id} has malformed Tested state`);
    return Object.freeze({ path: validateRelativeEvidencePath(match[1], `${record.id} Tested state path`), expected: match[2], hash: match[3] ?? null });
  });
  if (entries.length === 0) throw new ExecutionContractError(`${record.id} has empty Tested state`);
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new ExecutionContractError(`${record.id} has duplicate Tested state paths`);
  if (paths.some((value, index) => index > 0 && value.localeCompare(paths[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${record.id} Tested state paths are not lexicographically ordered`);
  }
  return entries;
}

function parseInlinePathSet(value, label) {
  if (!/^\S+(?:, \S+)*$/u.test(value)) throw new ExecutionContractError(`${label} has malformed path set`);
  const values = value.split(", ").map((entry) => validateRelativeEvidencePath(entry, `${label} path`));
  if (new Set(values).size !== values.length) throw new ExecutionContractError(`${label} has duplicate paths`);
  if (values.some((entry, index) => index > 0 && entry.localeCompare(values[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${label} paths are not lexicographically ordered`);
  }
  return values;
}

function discoveryContractViolation(record, { artifact = null, section = "Implementation Test Evidence" } = {}) {
  const canonicalSources = exactFieldLines(record.body, "Discovery sources");
  const canonicalActions = exactFieldLines(record.body, "Discovery actions");
  const legacySources = exactFieldLines(record.body, "Check discovery sources");
  const legacyActions = exactFieldLines(record.body, "Check discovery actions");
  if (legacySources.length === 0 && legacyActions.length === 0) return null;
  const mechanical = canonicalSources.length === 0 && canonicalActions.length === 0
    && legacySources.length === 1 && legacyActions.length === 1
    && legacySources[0][1].length !== 0 && legacyActions[0][1].length !== 0;
  return Object.freeze({
    kind: "legacy-discovery-labels",
    artifact,
    section,
    record: record.id,
    expectedField: "Discovery sources / Discovery actions",
    foundField: "Check discovery sources / Check discovery actions",
    owner: "execution-contract-runtime",
    repairability: mechanical ? "mechanical" : "blocked",
    reason: mechanical ? "exact-approved-label-pair" : "legacy-canonical-conflict-or-incomplete-pair",
  });
}

function throwDiscoveryViolation(violation) {
  throw new ExecutionContractError(
    `${violation.artifact ?? violation.record}:${violation.record} uses legacy discovery labels; contract repair ${violation.repairability}`,
    violation.artifact === null ? [] : [violation.artifact],
    [],
    violation,
  );
}

function findingsIdContractViolation(record, {
  artifact = null,
  section = "Findings Test Evidence",
  declaredFindingIds = new Set(),
} = {}) {
  const canonical = exactFieldLines(record.body, "Finding IDs");
  const legacy = exactFieldLines(record.body, "Findings IDs");
  if (canonical.length === 1 && legacy.length === 0) return null;

  let reason = "unknown-or-missing-field";
  let foundField = null;
  let repairability = "blocked";
  if (canonical.length > 1) {
    reason = "duplicate-canonical-field";
    foundField = "Finding IDs";
  } else if (canonical.length === 1 && legacy.length !== 0) {
    reason = "canonical-and-alias-conflict";
    foundField = "Findings IDs";
  } else if (legacy.length > 1) {
    reason = "duplicate-legacy-field";
    foundField = "Findings IDs";
  } else if (legacy.length === 1) {
    foundField = "Findings IDs";
    const value = legacy[0][1].trim();
    try {
      parseCanonicalFindingIds(value, record.id, { declaredFindingIds });
      reason = "exact-approved-alias";
      repairability = "mechanical";
    } catch {
      reason = "invalid-repair-value";
    }
  } else {
    const labels = [...record.body.matchAll(/^- ([^:\n]+):/gmu)].map((match) => match[1]);
    foundField = labels.find((label) => !CHECK_FIELD_NAMES.has(label)) ?? null;
  }
  return Object.freeze({
    kind: "non-canonical-field",
    artifact,
    section,
    record: record.id,
    expectedField: "Finding IDs",
    foundField,
    owner: "execution-contract-runtime",
    repairability,
    reason,
  });
}

function throwFindingsIdViolation(violation) {
  const found = violation.foundField === null ? "missing field" : `'${violation.foundField}'`;
  throw new ExecutionContractError(
    `${violation.artifact ?? violation.record}:${violation.record} expected exactly one 'Finding IDs' field; found ${found}; contract repair ${violation.repairability}`,
    violation.artifact === null ? [] : [violation.artifact],
    [],
    violation,
  );
}

function parseChecks(section, prefix, context = {}, authority = {}) {
  const records = operationRecords(section, prefix, { statusValues: new Set(["TESTS_PASS", "TESTS_ACCEPTED", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"]) });
  for (const record of records) {
    validateNestedScoping(record, { allowTestedState: true });
    const discoveryViolation = discoveryContractViolation(record, context);
    if (discoveryViolation !== null) throwDiscoveryViolation(discoveryViolation);
    if (prefix === "implementation-check") validateRecordFields(record, IMPLEMENTATION_CHECK_FIELD_NAMES);
    const round = field(record.body, "Automatic check round").match(/^([123])\/3$/u);
    if (round === null) throw new ExecutionContractError(`${record.id} has invalid Automatic check round`);
    record.round = Number(round[1]);
    for (const name of ["HEAD", "Tested scope", "Discovery sources", "Discovery actions", "Verification types considered", "Selected checks", "Selection rationale", "Coverage", "Failures", "Blockers", "Unexpected workspace effects", "Persistence summary"]) {
      requirePresentValue(field(record.body, name), `${record.id} ${name}`);
    }
    if (["TESTS_PASS", "TESTS_ACCEPTED"].includes(record.status)) {
      for (const name of ["Tested scope", "Verification types considered", "Selected checks", "Coverage"]) {
        requireNonPlaceholder(field(record.body, name), `${record.id} ${name}`);
      }
    }
    record.testedState = requireTestedState(record);
    record.commands = requireCommands(record, {
      permitNone: new Set(["TESTS_NOT_APPLICABLE", "BLOCKED"]).has(record.status),
      requireZero: false,
    });
    record.provenance = parseEvidenceProvenance(record, authority, {
      operation: prefix === "implementation-check" ? "EXECUTE_SLICE" : "APPLY_FINDINGS",
      round: `${record.round}/3`,
      required: context.evidenceContract === "stnl-validation-evidence/v1",
    });
    if (record.provenance !== null && JSON.stringify(record.provenance.subjects) !== JSON.stringify(
      record.testedState.map(({ path: subjectPath, expected }) => ({ path: subjectPath, expected })),
    )) throw new ExecutionContractError(`${record.id} Tested state disagrees with Evidence provenance subjects`);
    validateGateResult(record, authority);
    if (record.status === "TESTS_FAIL" && !record.commands.some((entry) => entry.exit !== 0)) {
      throw new ExecutionContractError(`${record.id} TESTS_FAIL must contain a nonzero command exit`);
    }
    if (record.status === "TESTS_NOT_APPLICABLE") {
      if (field(record.body, "Commands") !== "none") throw new ExecutionContractError(`${record.id} TESTS_NOT_APPLICABLE Commands must be none`);
      requireNonPlaceholder(field(record.body, "Non-applicability rationale"), `${record.id} Non-applicability rationale`);
      requireNonPlaceholder(field(record.body, "No verification-command confirmation"), `${record.id} No verification-command confirmation`);
    }
    if (prefix === "findings-check") {
      const violation = findingsIdContractViolation(record, context);
      if (violation !== null) throwFindingsIdViolation(violation);
      validateRecordFields(record, CHECK_FIELD_NAMES);
      record.findingsCycle = field(record.body, "Findings cycle");
      if (!/^attempt-[0-9]{2,}$/u.test(record.findingsCycle)) throw new ExecutionContractError(`${record.id} has invalid Findings cycle`);
      for (const name of ["Finding IDs", "Findings verified", "Corrections covered", "Regressions", "Unsupported active findings"]) {
        requirePresentValue(field(record.body, name), `${record.id} ${name}`);
      }
      record.findingIds = parseCanonicalFindingIds(field(record.body, "Finding IDs"), record.id, {
        declaredFindingIds: context.declaredFindingIds,
      });
      record.findingsVerified = parseCanonicalFindingIds(field(record.body, "Findings verified"), `${record.id} Findings verified`, {
        allowNone: true,
        declaredFindingIds: context.declaredFindingIds,
      });
      record.unsupportedActiveFindings = parseCanonicalFindingIds(
        field(record.body, "Unsupported active findings"),
        `${record.id} Unsupported active findings`,
        { allowNone: true, declaredFindingIds: context.declaredFindingIds },
      );
      if (record.testedState.length === 0) {
        requireNonPlaceholder(field(record.body, "Corrections covered"), `${record.id} Corrections covered`);
      }
    }
    if (record.round > 1) {
      for (const name of ["Prior-round failure", "Correction applied", "Updated scope", "In-slice rationale"]) {
        requireNonPlaceholder(field(record.body, name), `${record.id} ${name}`);
      }
      const correctionPaths = field(record.body, "Correction paths");
      if (correctionPaths === "none") {
        if (record.testedState.length !== 0) {
          throw new ExecutionContractError(`${record.id} file-backed Correction paths cannot be none`);
        }
        record.correctionPaths = [];
      } else {
        record.correctionPaths = parseInlinePathSet(correctionPaths, `${record.id} Correction paths`);
      }
    }
  }
  let previous = null;
  for (const record of records) {
    const changedCycle = prefix === "findings-check" && previous !== null && record.findingsCycle !== previous.findingsCycle;
    if (previous === null || changedCycle) {
      if (record.round !== 1) throw new ExecutionContractError(`${record.id} must start its automatic check cycle at round 1/3`);
      if (changedCycle) {
        const priorCycle = Number(previous.findingsCycle.slice("attempt-".length));
        const currentCycle = Number(record.findingsCycle.slice("attempt-".length));
        if (currentCycle <= priorCycle) throw new ExecutionContractError(`${record.id} Findings cycle must move forward`);
      }
    } else if (previous.status === "TESTS_FAIL" && previous.round < 3) {
      if (record.round !== previous.round + 1 && !(record.round === 1 && record.gates.some((gate) => gate.revalidates?.startsWith("divergence-")))) throw new ExecutionContractError(`${record.id} must immediately follow ${previous.id} at round ${previous.round + 1}/3`);
    } else if (previous.status === "BLOCKED") {
      if (record.round !== 1) throw new ExecutionContractError(`${record.id} must restart at round 1/3 after ${previous.id} BLOCKED`);
    } else {
      throw new ExecutionContractError(`${record.id} appears after terminal automatic-check record ${previous.id}`);
    }
    if (record.provenance !== null) {
      const expectedPrior = previous?.provenance?.evidenceId ?? null;
      if (record.provenance.priorEvidenceId !== expectedPrior) {
        throw new ExecutionContractError(`${record.id} Evidence provenance does not follow the prior validation record`);
      }
    }
    previous = record;
  }
  return records;
}

function baseState(section, attempts) {
  if (section === "- none") return { present: false, paths: [], entries: [] };
  const allowedFields = new Set(["Origin attempt", "Attempt type", "HEAD", "Result", "Files", "Fileless reason", "Authoritative commands", "Evidence summary"]);
  const fieldNames = [...section.matchAll(/^- ([^:\n]+):/gmu)].map((match) => match[1]);
  const unknownField = fieldNames.find((name) => !allowedFields.has(name));
  if (unknownField !== undefined) throw new ExecutionContractError(`Effective Validation Base has an unknown field: ${unknownField}`);
  const duplicateField = fieldNames.find((name, index) => fieldNames.indexOf(name) !== index);
  if (duplicateField !== undefined) throw new ExecutionContractError(`Effective Validation Base must contain exactly one ${duplicateField} field`);
  const origin = field(section, "Origin attempt");
  const owningAttempt = attempts.at(-1);
  if (owningAttempt?.id !== origin || !SUCCESS_RESULTS.has(owningAttempt?.status)) throw new ExecutionContractError("Effective Validation Base does not originate from the latest successful validation attempt");
  if (field(section, "Attempt type") !== field(owningAttempt.body, "Type")) throw new ExecutionContractError("Effective Validation Base Attempt type disagrees with its origin attempt");
  if (field(section, "HEAD") !== field(owningAttempt.body, "HEAD")) throw new ExecutionContractError("Effective Validation Base HEAD disagrees with its origin attempt");
  if (field(section, "Result") !== owningAttempt.status) throw new ExecutionContractError("Effective Validation Base Result must match its owning PASS/ACCEPTED attempt");
  const nestedFiles = [...section.matchAll(/^- Files:$/gmu)];
  const filelessFiles = [...section.matchAll(/^- Files: none$/gmu)];
  if (nestedFiles.length + filelessFiles.length !== 1) throw new ExecutionContractError("Effective Validation Base must contain exactly one Files field");
  const fileless = filelessFiles.length === 1;
  const filesMarker = fileless ? filelessFiles[0].index : nestedFiles[0].index;
  const commandMarkers = [...section.matchAll(/^- Authoritative commands:$/gmu)];
  const evidenceMarkers = [...section.matchAll(/^- Evidence summary:[ \t]*(.*)$/gmu)];
  if (commandMarkers.length !== 1) throw new ExecutionContractError("Effective Validation Base must contain exactly one Authoritative commands field");
  if (evidenceMarkers.length !== 1) throw new ExecutionContractError("Effective Validation Base must contain exactly one Evidence summary field");
  const commandsMarker = commandMarkers[0].index;
  const evidenceMarker = evidenceMarkers[0].index;
  if (filesMarker < 0 || commandsMarker <= filesMarker || evidenceMarker <= commandsMarker) throw new ExecutionContractError("Effective Validation Base field order is malformed");
  const evidenceEnd = evidenceMarker + evidenceMarkers[0][0].length;
  if (section.slice(evidenceEnd).trim().length !== 0) {
    throw new ExecutionContractError("Effective Validation Base has unexpected content after Evidence summary");
  }
  const filesSection = section.slice(filesMarker, commandsMarker).trimEnd();
  const entries = [];
  if (fileless) {
    const filelessLines = filesSection.split("\n").filter((line) => line.length !== 0);
    if (filelessLines.length !== 2 || filelessLines[0] !== "- Files: none" || !filelessLines[1].startsWith("- Fileless reason: ")) {
      throw new ExecutionContractError("Effective Validation Base fileless manifest requires exactly Files: none and Fileless reason");
    }
    requireNonPlaceholder(field(filesSection, "Fileless reason"), "Effective Validation Base Fileless reason");
  } else {
    if (field(section, "Fileless reason", { required: false }) !== null) {
      throw new ExecutionContractError("Effective Validation Base Fileless reason is permitted only with Files: none");
    }
    const fileLines = filesSection.split("\n").slice(1).filter((line) => line.length !== 0);
    if (fileLines.length === 0 || fileLines.some((line) => !/^  - `[^`]+` \| (?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(line))) {
      throw new ExecutionContractError("Effective Validation Base has a malformed Files manifest");
    }
    for (const match of filesSection.matchAll(/^  - `([^`]+)` \| (sha256:([0-9a-f]{64})|REMOVED)$/gmu)) {
      entries.push({ path: match[1], expected: match[2], hash: match[3] ?? null });
    }
  }
  const paths = entries.map((entry) => entry.path);
  if (!fileless && paths.length === 0) throw new ExecutionContractError("Effective Validation Base has an empty manifest");
  if (new Set(paths).size !== paths.length) throw new ExecutionContractError("Effective Validation Base has duplicate paths");
  if (paths.some((value, index) => index > 0 && value.localeCompare(paths[index - 1], "en") <= 0)) {
    throw new ExecutionContractError("Effective Validation Base paths are not lexicographically ordered");
  }
  const commandSection = section.slice(commandsMarker, evidenceMarker).trimEnd();
  const commandLines = commandSection.split("\n").slice(1).filter((line) => line.length !== 0);
  if (commandLines.length === 0 || commandLines.some((line) => !/^  - `[^`]+` \| exit:[-]?[0-9]+$/u.test(line))) {
    throw new ExecutionContractError("Effective Validation Base has malformed Authoritative commands");
  }
  const commands = commandLines.map((line) => {
    const match = line.match(/^  - `([^`]+)` \| exit:([-]?[0-9]+)$/u);
    return Object.freeze({ command: match[1], exit: Number(match[2]) });
  });
  if (JSON.stringify(commands) !== JSON.stringify(owningAttempt.commands)) {
    throw new ExecutionContractError("Effective Validation Base authoritative commands disagree with its origin attempt");
  }
  const evidenceSummary = field(section, "Evidence summary");
  requireNonPlaceholder(evidenceSummary, "Effective Validation Base Evidence summary");
  if (evidenceSummary !== field(owningAttempt.body, "Evidence")) {
    throw new ExecutionContractError("Effective Validation Base Evidence summary disagrees with its origin attempt");
  }
  if (owningAttempt.provenance !== null && JSON.stringify(owningAttempt.provenance.subjects) !== JSON.stringify(
    entries.map(({ path: subjectPath, expected }) => ({ path: subjectPath, expected })),
  )) throw new ExecutionContractError("Effective Validation Base disagrees with its origin evidence subjects");
  return { present: true, fileless, paths, entries };
}

function finalState(section) {
  const normalized = normalizeText(section);
  if (normalized === "- pending") return { result: "pending", supersededBy: null, planRevision: null };
  if (["- PASS", "- ACCEPTED"].includes(normalized)) return { result: normalized.slice(2), supersededBy: null, planRevision: null };
  const superseded = normalized.match(/^- SUPERSEDED\n- Superseded by: (slice-[0-9]{2,})\n- Plan revision: ([1-9][0-9]*)$/u);
  if (superseded === null || !SLICE_FILE.test(`${superseded[1]}.md`)) throw new ExecutionContractError("Final Result is malformed");
  return { result: "SUPERSEDED", supersededBy: superseded[1], planRevision: Number(superseded[2]) };
}

function parseAttempts(section, authority, evidenceContract = null) {
  const attempts = operationRecords(section, "attempt", { statusValues: new Set(["PASS", "ACCEPTED", "NEEDS_FIX", "BLOCKED"]) });
  const firstSuccessIndex = attempts.findIndex((attempt) => SUCCESS_RESULTS.has(attempt.status));
  if (firstSuccessIndex >= 0 && firstSuccessIndex !== attempts.length - 1) {
    throw new ExecutionContractError(`${attempts[firstSuccessIndex].id} PASS/ACCEPTED is terminal; no later formal attempt is permitted`);
  }
  if (attempts.length > 0 && field(attempts[0].body, "Type") !== "initial") throw new ExecutionContractError("attempt-01 must be initial");
  for (const attempt of attempts.slice(1)) if (field(attempt.body, "Type") !== "revalidation") throw new ExecutionContractError(`${attempt.id} must be revalidation`);
  for (const attempt of attempts) {
    validateNestedScoping(attempt);
    validateRecordFields(attempt, ATTEMPT_FIELD_NAMES);
    for (const name of ["HEAD", "Verified scope", "Evidence", "Finding references", "Finding dispositions", "Blockers", "Unexpected workspace effects", "Persistence summary"]) {
      requirePresentValue(field(attempt.body, name), `${attempt.id} ${name}`);
    }
    attempt.commands = requireCommands(attempt, { permitNone: attempt.status === "BLOCKED", requireZero: false });
    attempt.provenance = parseEvidenceProvenance(attempt, authority, {
      operation: "VALIDATE_SLICE", round: null, required: evidenceContract === "stnl-validation-evidence/v1",
    });
    validateGateResult(attempt, authority);
    attempt.findingReferences = parseCanonicalFindingIds(
      field(attempt.body, "Finding references"),
      `${attempt.id} Finding references`,
      { allowNone: true },
    );
    attempt.findingDispositions = parseFindingDispositions(field(attempt.body, "Finding dispositions"), attempt.id);
    if (attempt.findingReferences.length !== attempt.findingDispositions.size
      || attempt.findingReferences.some((identifier) => !attempt.findingDispositions.has(identifier))) {
      throw new ExecutionContractError(`${attempt.id} Finding references and dispositions disagree`);
    }
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const current = attempts[index];
    if (current.provenance === null) continue;
    const expectedPrior = attempts[index - 1]?.provenance?.evidenceId ?? null;
    if (current.provenance.priorEvidenceId !== expectedPrior) {
      throw new ExecutionContractError(`${current.id} Evidence provenance does not follow the prior validation attempt`);
    }
  }
  return attempts;
}

function parsePriorValidationOverlaps(section, label, evidenceContract) {
  if (section === "- none") return [];
  if (evidenceContract !== "stnl-validation-evidence/v1") return [];
  const records = [];
  const blocks = String(section).trim().split(/\n\n(?=### overlap-[0-9]{2,}\n)/u);
  for (const block of blocks) {
    const match = block.match(/^### (overlap-[0-9]{2,})\n\n- Prior slice: (slice-[0-9]{2,})\n- Paths: ([^\n]+)\n- Affected behavior: ([^\n]+)\n- Regressions: ([^\n]+)$/u);
    if (match === null) throw new ExecutionContractError(`${label} has malformed Prior Validation Overlap`);
    const [, id, priorSlice, pathsValue, behavior, regressions] = match;
    requireNonPlaceholder(behavior, `${id} Affected behavior`);
    requireNonPlaceholder(regressions, `${id} Regressions`);
    records.push({ id, priorSlice, paths: parseInlinePathSet(pathsValue, `${id} Paths`), behavior, regressions });
  }
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new ExecutionContractError(`${label} has duplicate Prior Validation Overlap identifiers`);
  }
  return records;
}

function parseDelegationBlocker(section, operationRecordsByName, authority, evidenceContract) {
  if (section === "- none") return null;
  if (/<[^>\n]+>/u.test(section)) throw new ExecutionContractError("Delegation Blocker contains template placeholder content");
  const operation = field(section, "Operation");
  const kind = field(section, "Kind");
  const state = field(section, "State");
  const afterRecord = field(section, "After record");
  const pendingRoundValue = field(section, "Pending automatic round", { required: false });
  if (!SLICE_OPERATIONS.has(operation)) throw new ExecutionContractError("Delegation Blocker has invalid Operation");
  if (!new Set(["initialization", "malformed-output", "infrastructure"]).has(kind)) throw new ExecutionContractError("Delegation Blocker has invalid Kind");
  if (!new Set(["active", "resolved"]).has(state)) throw new ExecutionContractError("Delegation Blocker has invalid State");
  const causes = requireList(section, "Causes", "Delegation Blocker");
  requireNonPlaceholder(field(section, "Required action"), "Delegation Blocker Required action");
  const resolution = field(section, "Resolution", { required: false });
  if (state === "active" && resolution !== null) throw new ExecutionContractError("active Delegation Blocker cannot contain Resolution");
  if (state === "resolved") requireNonPlaceholder(field(section, "Resolution"), "Delegation Blocker Resolution");
  const records = operationRecordsByName.get(operation);
  const priorIndex = afterRecord === "none" ? -1 : records.findIndex((record) => record.id === afterRecord);
  if (afterRecord !== "none" && priorIndex < 0) throw new ExecutionContractError("Delegation Blocker After record does not exist for its Operation");
  if (state === "active" && priorIndex !== records.length - 1) throw new ExecutionContractError("active Delegation Blocker must be resolved after a later valid record");
  let pendingRound = null;
  if (operation === "VALIDATE_SLICE") {
    if (pendingRoundValue !== null && pendingRoundValue !== "none") throw new ExecutionContractError("VALIDATE_SLICE Delegation Blocker cannot carry an automatic round");
  } else if (pendingRoundValue !== null) {
    const match = pendingRoundValue.match(/^([123])\/3$/u);
    if (match === null) throw new ExecutionContractError("Delegation Blocker has invalid Pending automatic round");
    pendingRound = Number(match[1]);
    const prior = priorIndex < 0 ? null : records[priorIndex];
    const expected = prior === null || prior.status === "BLOCKED" ? 1
      : prior.status === "TESTS_FAIL" && prior.round < 3 ? prior.round + 1 : null;
    if (expected === null || pendingRound !== expected) {
      throw new ExecutionContractError("Delegation Blocker pending round disagrees with the interrupted logical invocation");
    }
  }
  let provenance = null;
  if (kind === "infrastructure") {
    if (evidenceContract !== "stnl-validation-evidence/v1") {
      throw new ExecutionContractError("infrastructure Delegation Blocker requires the v1 evidence contract");
    }
    provenance = parseEvidenceProvenance(
      { id: "Delegation Blocker", body: section, status: "BLOCKED", commands: [] },
      authority,
      { operation, round: operation === "VALIDATE_SLICE" ? null : `${pendingRound}/3`, required: true },
    );
    const expectedCause = `${provenance.blocker.code}: ${provenance.blocker.message}`;
    if (causes.length !== 1 || causes[0] !== expectedCause) {
      throw new ExecutionContractError("infrastructure Delegation Blocker cause disagrees with Evidence provenance");
    }
    const prior = priorIndex < 0 ? null : records[priorIndex];
    if (provenance.priorEvidenceId !== (prior?.provenance?.evidenceId ?? null)) {
      throw new ExecutionContractError("infrastructure Delegation Blocker Evidence provenance does not follow the prior validation record");
    }
  } else if (field(section, "Evidence provenance", { required: false }) !== null
    || field(section, "HEAD", { required: false }) !== null) {
    throw new ExecutionContractError(`${kind} Delegation Blocker cannot claim validation Evidence provenance`);
  }
  if (state === "resolved") {
    if (records.length <= priorIndex + 1) throw new ExecutionContractError("resolved Delegation Blocker requires a later valid record");
    const resolvingRecord = records[priorIndex + 1].id;
    const resolutionText = field(section, "Resolution");
    const namedRecords = [...resolutionText.matchAll(/\b(?:implementation-check|findings-check|attempt)-[0-9]{2,}\b/gu)].map((match) => match[0]);
    if (namedRecords.length !== 1 || namedRecords[0] !== resolvingRecord) {
      throw new ExecutionContractError(`Delegation Blocker Resolution must name ${resolvingRecord}`);
    }
  }
  return { operation, kind, state, afterRecord, pendingRound, provenance };
}

function validateFindingLifecycle(findings, attempts, findingsChecks) {
  const attemptsById = new Map(attempts.map((attempt, index) => [attempt.id, { ...attempt, index }]));
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const resolutionIndexes = new Map();
  for (const finding of findings) {
    const origin = attemptsById.get(finding.origin);
    if (origin === undefined || origin.status !== "NEEDS_FIX") throw new ExecutionContractError(`${finding.id} Origin must name an existing NEEDS_FIX attempt`);
    if (finding.state === "resolved") {
      const resolutionAttemptId = field(finding.body, "Resolution").match(/\battempt-[0-9]{2,}\b/u)?.[0];
      const resolution = attemptsById.get(resolutionAttemptId);
      if (resolution === undefined || resolution.index <= origin.index || !new Set(["PASS", "ACCEPTED", "NEEDS_FIX", "BLOCKED"]).has(resolution.status)) {
        throw new ExecutionContractError(`${finding.id} Resolution must name an existing strictly later formal attempt`);
      }
      if (resolution.status === "BLOCKED" && !resolution.gates.some((gate) => gate.revalidates === finding.id && ["resolved", "non_blocking"].includes(gate.decision))) throw new ExecutionContractError(`${finding.id} BLOCKED resolution requires explicit revalidation evidence`);
      resolutionIndexes.set(finding.id, resolution.index);
    }
    if (finding.state === "superseded") {
      const replacement = findingsById.get(field(finding.body, "Superseded by"));
      const replacementOrigin = replacement === undefined ? null : attemptsById.get(replacement.origin);
      if (replacementOrigin === undefined || replacementOrigin === null || replacementOrigin.index <= origin.index) {
        throw new ExecutionContractError(`${finding.id} superseding finding origin must be strictly later than its own origin`);
      }
    }
  }
  const findingStateAtAttempt = (finding, attemptIndex) => {
    if (attemptsById.get(finding.origin).index > attemptIndex) return null;
    if (finding.state === "resolved" && attemptIndex >= resolutionIndexes.get(finding.id)) return "resolved";
    if (finding.state === "superseded") {
      const replacement = findingsById.get(field(finding.body, "Superseded by"));
      const replacementOrigin = replacement === undefined ? null : attemptsById.get(replacement.origin);
      if (replacementOrigin === undefined || replacementOrigin === null) {
        throw new ExecutionContractError(`${finding.id} Superseded by has no formal-attempt origin`);
      }
      if (attemptIndex >= replacementOrigin.index) return "superseded";
    }
    return "active";
  };
  for (const [attemptIndex, attempt] of attempts.entries()) {
    for (const identifier of attempt.findingReferences) {
      const finding = findingsById.get(identifier);
      if (finding === undefined) throw new ExecutionContractError(`${attempt.id} references undeclared ${identifier}`);
      if (attemptsById.get(finding.origin).index > attemptIndex) {
        throw new ExecutionContractError(`${attempt.id} references ${identifier} before its origin attempt`);
      }
    }
    const applicable = findings.filter((finding) => attemptsById.get(finding.origin).index <= attemptIndex).sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (attempt.findingReferences.length !== applicable.length
      || attempt.findingReferences.some((identifier, index) => identifier !== applicable[index].id)) {
      throw new ExecutionContractError(`${attempt.id} must dispose every finding in its authority`);
    }
    for (const finding of applicable) {
      const expectedState = findingStateAtAttempt(finding, attemptIndex);
      if (attempt.findingDispositions.get(finding.id) !== expectedState) {
        throw new ExecutionContractError(`${attempt.id} disposition contradicts ${finding.id} deterministic timeline`);
      }
    }
  }
  for (const check of findingsChecks) {
    const cycle = attemptsById.get(check.findingsCycle);
    if (cycle === undefined || cycle.status !== "NEEDS_FIX") throw new ExecutionContractError(`${check.id} Findings cycle must name an existing NEEDS_FIX attempt`);
    const latestApplicable = attempts.slice(0, cycle.index + 1).filter((attempt) => attempt.status === "NEEDS_FIX").at(-1);
    if (latestApplicable?.id !== check.findingsCycle) throw new ExecutionContractError(`${check.id} Findings cycle is not the latest applicable NEEDS_FIX attempt`);
    for (const identifier of check.findingIds) {
      const finding = findingsById.get(identifier);
      if (finding === undefined) throw new ExecutionContractError(`${check.id} references undeclared ${identifier}`);
      if (attemptsById.get(finding.origin).index > cycle.index) throw new ExecutionContractError(`${check.id} references ${identifier} outside its Findings cycle`);
    }
    if (check.findingsVerified.some((identifier) => !check.findingIds.includes(identifier))) {
      throw new ExecutionContractError(`${check.id} Findings verified must be a subset of Finding IDs`);
    }
    const activeAtCycle = findings.filter((finding) => findingStateAtAttempt(finding, cycle.index) === "active")
      .map((finding) => finding.id).sort();
    if (check.findingIds.some((identifier) => !activeAtCycle.includes(identifier))) {
      throw new ExecutionContractError(`${check.id} verifies a finding that is not active in its cycle`);
    }
    const unsupported = activeAtCycle.filter((identifier) => !check.findingsVerified.includes(identifier));
    if (unsupported.length !== check.unsupportedActiveFindings.length
      || unsupported.some((identifier, index) => identifier !== check.unsupportedActiveFindings[index])) {
      throw new ExecutionContractError(`${check.id} Unsupported active findings contradict the canonical active set`);
    }
  }
}

function changedPathClaims(section, label, sentinels) {
  if (sentinels.has(section)) return [];
  const lines = section.split("\n");
  if (lines.length === 0 || lines.some((line) => !/^- `[^`]+`$/u.test(line))) {
    throw new ExecutionContractError(`${label} must contain only canonical task-relative path claims`);
  }
  const claims = lines.map((line) => validateRelativeEvidencePath(line.slice(3, -1), `${label} path`));
  if (new Set(claims).size !== claims.length) throw new ExecutionContractError(`${label} has duplicate path claims`);
  if (claims.some((value, index) => index > 0 && value.localeCompare(claims[index - 1], "en") <= 0)) {
    throw new ExecutionContractError(`${label} path claims are not lexicographically ordered`);
  }
  return claims;
}

function validateRelativeEvidencePath(value, label) {
  if (value.length === 0 || value.includes("\\") || value.includes("\0") || value.endsWith("/")
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === ".") {
    throw new ExecutionContractError(`${label} is not a normalized relative path: ${value}`);
  }
  return value;
}

function validateGateHistory(records, findings, divergences) {
  const seen = new Map();
  const pending = new Map();
  for (const record of records) {
    const successors = new Map();
    for (const [reference, prior] of pending) {
      const matches = record.gates.filter((gate) => gate.identity === prior.identity
        || gate.revalidates === reference
        || prior.divergenceIds?.includes(gate.revalidates)
        || (gate.revalidates !== null && seen.get(gate.revalidates)?.lineage === prior.lineage));
      if (matches.length !== 1) throw new ExecutionContractError(`${record.id} must revalidate prior blocker ${reference} exactly once`);
      successors.set(matches[0], prior.lineage);
    }
    for (const gate of record.gates) {
      const target = gate.revalidates;
      if (target !== null) {
        if (target.includes("/") && !seen.has(target)) throw new ExecutionContractError(`${record.id} revalidates an unknown or future gate`);
        if (target.startsWith("finding-") && !findings.some((finding) => finding.id === target && seen.has(finding.origin))) throw new ExecutionContractError(`${record.id} revalidates an unknown or future finding`);
        if (target.startsWith("divergence-") && !divergences.some((entry) => entry.id === target)) throw new ExecutionContractError(`${record.id} revalidates an unknown divergence`);
      }
      const prior = target?.includes("/") ? seen.get(target) : undefined;
      const inherited = [...pending.values()].filter((entry) => entry.identity === gate.identity
        || entry.lineage === successors.get(gate));
      const divergenceIds = new Set([
        ...(target?.startsWith("divergence-") ? [target] : []),
        ...(prior?.divergenceIds ?? []), ...inherited.flatMap((entry) => entry.divergenceIds ?? []),
      ]);
      const protectedObligation = gate.kind !== "quality" || gate.causality === "required_by_slice"
        || prior?.protectedObligation === true || inherited.some((entry) => entry.protectedObligation);
      successors.set(gate, { lineage: successors.get(gate), divergenceIds: [...divergenceIds], protectedObligation });
      if (protectedObligation && (gate.bypass !== null || gate.decision === "non_blocking")) {
        throw new ExecutionContractError(`${record.id} revalidation cannot demote or bypass a structural or mandatory gate obligation`);
      }
      for (const id of divergenceIds) {
        const divergence = divergences.find((entry) => entry.id === id);
        if (gate.bypass !== null) throw new ExecutionContractError("Authority divergences cannot be bypassed");
        if (gate.decision === "non_blocking" && divergence.kind !== "observational") {
          throw new ExecutionContractError(`${id} ${divergence.kind} divergence cannot become non_blocking; required authority operation ${divergence.requiredAuthorityOperation} remains mandatory while present`);
        }
      }
      if (gate.bypass !== null) {
        if (![...seen.values()].some((prior) => prior.identity === gate.identity && ["blocking", "bypassed"].includes(prior.decision))) {
          throw new ExecutionContractError(`${record.id} bypass requires a previously observed concrete blocker`);
        }
        if (gate.decision !== "bypassed" && ![...seen.values()].some((prior) => prior.identity === gate.identity
          && prior.bypass !== null && prior.bypass !== undefined
          && ["target", "operator", "reason", "authorization"].every((key) => prior.bypass[key] === gate.bypass[key]))) {
          throw new ExecutionContractError(`${record.id} historical bypass requires its previously recorded authorization`);
        }
      }
    }
    pending.clear();
    for (const gate of record.gates) {
      const reference = `${record.id}/${gate.id}`;
      const observation = { ...gate, ...successors.get(gate), lineage: successors.get(gate)?.lineage ?? reference };
      seen.set(reference, observation);
      if (!NON_BLOCKING_GATES.has(gate.decision) || gate.decision === "bypassed") pending.set(reference, observation);
    }
    seen.set(record.id, record);
  }
}

function chronologicalQualityRecords(implementationChecks, findingsChecks, attempts) {
  return [...implementationChecks, ...attempts.flatMap((attempt) => [attempt,
    ...findingsChecks.filter((check) => check.findingsCycle === attempt.id),
  ])];
}

function parseTask(text, label, expectedSlice, references = {}) {
  const { header, body } = parsePurpose(text, label);
  if (header.get("status") !== "ready") throw new ExecutionContractError(`${label} must have status ready`);
  if (header.get("owner") !== "stnl-task-materializer") throw new ExecutionContractError(`${label} has the wrong File Purpose Header owner`);
  const h1 = body.match(/^# ([^\n]+)\n\n/u)?.[1];
  if (!new RegExp(`^Slice ${expectedSlice.slice(6)} Tasks - \\S.*$`, "u").test(h1 ?? "")) {
    throw new ExecutionContractError(`${label} has a non-canonical primary heading`);
  }
  const taskSections = sections(body);
  requireCanonicalSections(taskSections, TASK_SECTIONS, label);
  if (!taskSections.has("References")) throw new ExecutionContractError(`${label} is missing References`);
  const state = authorityFields(taskSections.get("References"), label);
  const evidenceContract = field(taskSections.get("References"), "Validation evidence contract", { required: false });
  if (evidenceContract !== null && evidenceContract !== "stnl-validation-evidence/v1") {
    throw new ExecutionContractError(`${label} has an unsupported Validation evidence contract`);
  }
  if (references.requirementsSource !== undefined) referenceValue(taskSections.get("References"), "Requirements source", references.requirementsSource, label);
  referenceValue(taskSections.get("References"), "Plan", `../plans/${expectedSlice}.md`, label);
  referenceValue(taskSections.get("References"), "Global tasks", "../tasks.md", label);
  const declared = field(body, "Slice");
  if (declared !== expectedSlice.slice("slice-".length)) throw new ExecutionContractError(`${label} declares the wrong slice`);
  for (const name of PRISTINE.keys()) if (!taskSections.has(name)) throw new ExecutionContractError(`${label} is missing ${name}`);
  const declaredFindingIds = new Set([
    ...taskSections.get("Validation Findings").matchAll(/^### (finding-[0-9]{2,})$/gmu),
  ].map((match) => match[1]));
  const gateAuthority = { ...state, slice: expectedSlice };
  const implementationChecks = parseChecks(taskSections.get("Implementation Test Evidence"), "implementation-check", {
    artifact: label,
    section: "Implementation Test Evidence",
    declaredFindingIds,
    evidenceContract,
  }, gateAuthority);
  const findingsChecks = parseChecks(taskSections.get("Findings Test Evidence"), "findings-check", {
    artifact: label,
    section: "Findings Test Evidence",
    declaredFindingIds,
    evidenceContract,
  }, gateAuthority);
  const attempts = parseAttempts(taskSections.get("Validation Attempts"), gateAuthority, evidenceContract);
  const findings = blockerRecords(taskSections.get("Validation Findings"), "finding");
  const divergences = blockerRecords(taskSections.get("Divergences"), "divergence");
  const qualityRecords = chronologicalQualityRecords(implementationChecks, findingsChecks, attempts);
  validateGateHistory(qualityRecords, findings, divergences);
  validateFindingLifecycle(findings, attempts, findingsChecks);
  for (const divergence of divergences.filter((entry) => entry.revalidationRecord !== undefined)) {
    const record = qualityRecords.find((entry) => entry.id === divergence.revalidationRecord);
    if (record === undefined || !record.gates.some((gate) => gate.revalidates === divergence.id
      && ["resolved", "non_blocking"].includes(gate.decision))) throw new ExecutionContractError(`${divergence.id} resolution lacks current revalidation evidence`);
  }
  const delegationBlocker = parseDelegationBlocker(taskSections.get("Delegation Blocker"), new Map([
    ["EXECUTE_SLICE", implementationChecks], ["APPLY_FINDINGS", findingsChecks], ["VALIDATE_SLICE", attempts],
  ]), gateAuthority, evidenceContract);
  if (evidenceContract === "stnl-validation-evidence/v1"
    && delegationBlocker?.operation !== "VALIDATE_SLICE"
    && delegationBlocker?.pendingRound === null) {
    throw new ExecutionContractError(`${label} v1 auxiliary Delegation Blocker requires Pending automatic round`);
  }
  const base = baseState(taskSections.get("Effective Validation Base"), attempts);
  for (const entry of base.entries) validateRelativeEvidencePath(entry.path, `${label} Effective Validation Base path`);
  const final = finalState(taskSections.get("Final Result"));
  const changedAreasSection = taskSections.get("Changed Areas");
  const changedAreas = changedPathClaims(changedAreasSection, `${label} Changed Areas`, new Set(["- pending", "- none"]));
  const corrections = changedPathClaims(taskSections.get("Corrections Applied"), `${label} Corrections Applied`, new Set(["- none"]));
  const priorValidationOverlaps = parsePriorValidationOverlaps(taskSections.get("Prior Validation Overlap"), label, evidenceContract);
  if (corrections.some((claim) => !changedAreas.includes(claim))) throw new ExecutionContractError(`${label} correction path is absent from Changed Areas`);
  const changedClaims = [...new Set([...changedAreas, ...corrections])];
  const checklist = taskSections.get("Checklist") ?? "";
  const checklistRows = checklist.split("\n").filter((line) => line.length !== 0).map((line) => {
    const match = line.match(/^- \[([ x])\] ([0-9]+\.[0-9]+) \S.* \| observable result: \S.* \| expected areas: \S.* \| requirement: (\S.*)$/u);
    if (match === null) throw new ExecutionContractError(`${label} has malformed Checklist row: ${line}`);
    return {
      done: match[1] === "x",
      id: match[2],
      requirements: parseCanonicalReferenceList(match[3], `${label} Checklist ${match[2]} requirement`),
    };
  });
  if (checklistRows.length === 0) throw new ExecutionContractError(`${label} has no canonical checklist rows`);
  if (new Set(checklistRows.map((row) => row.id)).size !== checklistRows.length) throw new ExecutionContractError(`${label} has duplicate Checklist rows`);
  const checklistComplete = checklistRows.every((row) => row.done);
  const workStarted = checklistRows.some((row) => row.done) || implementationChecks.length !== 0
    || findingsChecks.length !== 0 || attempts.length !== 0 || corrections.length !== 0
    || delegationBlocker !== null || normalizeText(taskSections.get("Diff Summary")) !== "- pending";
  if (attempts.length !== 0 && !checklistComplete) throw new ExecutionContractError(`${label} has Validation Attempts before the mandatory checklist is complete`);
  const pristine = [...PRISTINE].every(([name, sentinel]) => taskSections.get(name) === sentinel)
    && !/^- \[x\]/gmu.test(taskSections.get("Checklist") ?? "");
  const activeBlockers = [...findings, ...divergences].filter((record) => record.severity === "blocking" && record.state === "active"
    && !(record.id.startsWith("finding-") && attempts.at(-1)?.gates.some((gate) => gate.revalidates === record.id && gate.decision === "bypassed")));
  const activeBlockingDivergence = divergences.some((record) => record.severity === "blocking" && record.state === "active");
  for (const [name, latest] of [["implementation", implementationChecks.at(-1)], ["findings", findingsChecks.at(-1)]]) {
    const expectedOperation = name === "implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS";
    const pausedByDelegation = delegationBlocker?.state === "active" && delegationBlocker.operation === expectedOperation
      && delegationBlocker.afterRecord === latest?.id;
    if (latest?.status === "TESTS_FAIL" && latest.round < 3 && !activeBlockingDivergence && !pausedByDelegation && attempts.length === 0) {
      throw new ExecutionContractError(`${label} has an unterminated ${name} automatic correction cycle without a blocking divergence`);
    }
  }
  if (attempts.at(-1)?.status === "NEEDS_FIX" && !findings.some((record) => record.severity === "blocking" && record.state === "active")) {
    throw new ExecutionContractError(`${label} latest NEEDS_FIX attempt has no active blocking finding`);
  }
  if (SUCCESS_RESULTS.has(final.result) && (!base.present || activeBlockers.length !== 0)) throw new ExecutionContractError(`${label} successful terminal result lacks a valid base or retains an active blocker`);
  if (SUCCESS_RESULTS.has(final.result) && attempts.at(-1)?.status !== final.result) throw new ExecutionContractError(`${label} successful terminal result does not originate from its latest formal attempt`);
  if (SUCCESS_RESULTS.has(final.result)) {
    const diffSummary = normalizeText(taskSections.get("Diff Summary"));
    if (!/^- \S.*$/u.test(diffSummary) || /^(?:- )?(?:none|pending|n\/a|not_available)$/iu.test(diffSummary)) {
      throw new ExecutionContractError(`${label} terminal PASS/ACCEPTED requires a non-placeholder Diff Summary`);
    }
  }
  if (SUCCESS_RESULTS.has(attempts.at(-1)?.status) && (final.result !== attempts.at(-1)?.status || !base.present)) throw new ExecutionContractError(`${label} latest successful validation attempt was not published atomically`);
  if (final.result === "SUPERSEDED" && base.present) throw new ExecutionContractError(`${label} SUPERSEDED must not retain an Effective Validation Base`);
  if (SUCCESS_RESULTS.has(final.result) && changedClaims.some((claim) => !base.paths.includes(claim))) {
    throw new ExecutionContractError(`${label} has a changed/corrected path with no validation owner`);
  }
  if (SUCCESS_RESULTS.has(final.result) && base.paths.some((entry) => !changedClaims.includes(entry))) {
    throw new ExecutionContractError(`${label} Effective Validation Base path is absent from Changed Areas/Corrections Applied`);
  }
  const latestAttempt = attempts.at(-1);
  const latestNeedsFix = attempts.filter((attempt) => attempt.status === "NEEDS_FIX").at(-1);
  let currentAuxiliaryCheck = null;
  if (!base.present) {
    if (latestAttempt === undefined) currentAuxiliaryCheck = implementationChecks.at(-1) ?? null;
    else if (latestAttempt.status === "NEEDS_FIX") {
      currentAuxiliaryCheck = findingsChecks.filter((check) => check.findingsCycle === latestAttempt.id).at(-1) ?? null;
    } else if (latestAttempt.status === "BLOCKED") {
      currentAuxiliaryCheck = latestNeedsFix === undefined
        ? implementationChecks.at(-1) ?? null
        : findingsChecks.filter((check) => check.findingsCycle === latestNeedsFix.id).at(-1) ?? null;
    }
  }
  if (base.present) {
    if (base.fileless !== (changedAreasSection === "- none")) {
      throw new ExecutionContractError(`${label} Effective Validation Base and Changed Areas disagree on fileless ownership`);
    }
  } else if (currentAuxiliaryCheck !== null) {
    const currentFileless = currentAuxiliaryCheck.testedState.length === 0;
    if (currentFileless !== (changedAreasSection === "- none")) {
      throw new ExecutionContractError(`${label} current fileless auxiliary check requires Changed Areas: none and current file-backed evidence requires paths`);
    }
  } else if (changedAreasSection === "- none") {
    throw new ExecutionContractError(`${label} Changed Areas: none requires current fileless check evidence or a fileless Effective Validation Base`);
  }
  let retryExhausted = null;
  const lastImplementation = implementationChecks.at(-1);
  const lastFindings = findingsChecks.at(-1);
  if (lastFindings?.status === "TESTS_FAIL" && lastFindings.round === 3) {
    const cycleNumber = Number(lastFindings.findingsCycle.slice("attempt-".length));
    if (attempts.length <= cycleNumber) retryExhausted = "FINDINGS";
  } else if (lastImplementation?.status === "TESTS_FAIL" && lastImplementation.round === 3 && attempts.length === 0) retryExhausted = "IMPLEMENTATION";
  if (retryExhausted !== null && activeBlockingDivergence) {
    throw new ExecutionContractError(`${label} cannot combine third-failure exhaustion with an active blocking divergence`);
  }
  const exhaustedOperation = retryExhausted === "IMPLEMENTATION" ? "EXECUTE_SLICE" : retryExhausted === "FINDINGS" ? "APPLY_FINDINGS" : null;
  if (delegationBlocker?.state === "active" && delegationBlocker.operation === exhaustedOperation) {
    throw new ExecutionContractError(`${label} cannot resume ${exhaustedOperation} after third-failure exhaustion`);
  }
  if (delegationBlocker?.state === "active") {
    const implementationTerminal = SUCCESS_CHECKS.has(lastImplementation?.status)
      || (lastImplementation?.status === "TESTS_FAIL" && lastImplementation.round === 3);
    const findingsTerminal = SUCCESS_CHECKS.has(lastFindings?.status)
      || (lastFindings?.status === "TESTS_FAIL" && lastFindings.round === 3);
    if (delegationBlocker.operation === "EXECUTE_SLICE" && implementationTerminal) {
      throw new ExecutionContractError(`${label} has a stale EXECUTE_SLICE Delegation Blocker after a terminal auxiliary result`);
    }
    if (delegationBlocker.operation === "APPLY_FINDINGS"
      && (attempts.at(-1)?.status !== "NEEDS_FIX" || findingsTerminal)) {
      throw new ExecutionContractError(`${label} has a stale APPLY_FINDINGS Delegation Blocker outside a corrective phase`);
    }
    if (delegationBlocker.operation === "VALIDATE_SLICE") {
      const latestAttempt = attempts.at(-1);
      const validationReady = (latestAttempt === undefined && implementationTerminal)
        || latestAttempt?.status === "BLOCKED"
        || (latestAttempt?.status === "NEEDS_FIX" && findingsTerminal);
      if (!validationReady) throw new ExecutionContractError(`${label} has a stale VALIDATE_SLICE Delegation Blocker outside a validation phase`);
    }
  }
  if (workStarted && taskSections.get("Changed Areas") === "- pending") {
    throw new ExecutionContractError(`${label} Changed Areas cannot remain pending after work`);
  }
  const currentFindingsCheck = latestNeedsFix === undefined ? null
    : findingsChecks.filter((check) => check.findingsCycle === latestNeedsFix.id).at(-1) ?? null;
  if (findingsChecks.length !== 0 && corrections.length === 0 && currentFindingsCheck?.testedState.length !== 0) {
    throw new ExecutionContractError(`${label} Findings Test Evidence requires Corrections Applied`);
  }
  for (const check of [...implementationChecks, ...findingsChecks].filter((record) => record.round > 1)) {
    if (check.correctionPaths.some((claim) => !corrections.includes(claim))) {
      throw new ExecutionContractError(`${check.id} Correction paths are absent from Corrections Applied`);
    }
    if (check.correctionPaths.some((claim) => !changedAreas.includes(claim))) {
      throw new ExecutionContractError(`${check.id} Correction paths are absent from Changed Areas`);
    }
  }
  return {
    ...state, evidenceContract, body, sections: taskSections, pristine, attempts, findings, divergences, activeBlockers,
    base, final, implementationChecks, findingsChecks, delegationBlocker, retryExhausted, checklistComplete,
    changedClaims, priorValidationOverlaps, checklistRows,
    coverageReferences: [...new Set(checklistRows.flatMap((row) => row.requirements))].sort((left, right) => left.localeCompare(right, "en")),
    claims: [...new Set([...changedClaims, ...base.paths])],
  };
}

async function rejectSymlinkComponents(targetPath, trustedRoot) {
  let current = trustedRoot;
  const relative = path.relative(trustedRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ExecutionContractError(`validation-owned path escapes its trusted workspace: ${targetPath}`, [targetPath]);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const metadata = await lstatOrNull(current);
    if (metadata === null) return;
    if (metadata.isSymbolicLink()) throw new ExecutionContractError(`validation-owned path traverses a symlink: ${current}`, [current]);
  }
}

async function trustedProjectRoot(workspace) {
  let current = path.dirname(workspace.authorityPath);
  for (;;) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return workspace.specRoot ?? path.dirname(workspace.authorityPath);
}

export async function computeValidationSourceFingerprint(projectRoot, executionRoot) {
  const trustedRoot = await fs.realpath(projectRoot);
  const excludedRoot = path.resolve(executionRoot);
  if (!pathIsWithin(excludedRoot, trustedRoot)) {
    throw new ExecutionContractError("validation execution root is outside its trusted project root");
  }
  const entries = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === ".git" || isIgnoredMetadata(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entryPath === excludedRoot || pathIsWithin(entryPath, excludedRoot)) continue;
      const relative = path.relative(trustedRoot, entryPath).split(path.sep).join("/");
      const metadata = await fs.lstat(entryPath);
      const mode = metadata.mode & 0o777;
      if (metadata.isSymbolicLink()) {
        const physical = await fs.realpath(entryPath);
        if (!pathIsWithin(physical, trustedRoot)) {
          throw new ExecutionContractError(`validation source symlink escapes its trusted project: ${relative}`);
        }
        entries.push([relative, "symlink", mode, await fs.readlink(entryPath)]);
      } else if (metadata.isDirectory()) {
        entries.push([relative, "directory", mode]);
        await visit(entryPath);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new ExecutionContractError(`validation source contains a hardlink: ${relative}`);
        entries.push([
          relative, "file", mode,
          createHash("sha256").update(await fs.readFile(entryPath)).digest("hex"),
        ]);
      } else throw new ExecutionContractError(`validation source contains an unsupported entry: ${relative}`);
    }
  }
  await visit(trustedRoot);
  return deterministicDigest("stnl-validation-source-v1", entries);
}

export async function readValidationHead(projectRoot) {
  try {
    const marker = path.join(projectRoot, ".git");
    const metadata = await fs.lstat(marker);
    let gitDirectory = marker;
    if (metadata.isFile()) {
      const pointer = (await fs.readFile(marker, "utf8")).trim().match(/^gitdir: ([^\n\r]+)$/u)?.[1];
      if (pointer === undefined || path.isAbsolute(pointer) || pointer.includes("\\") || pointer.split("/").includes("..")) return "not_available";
      gitDirectory = path.resolve(projectRoot, pointer);
    } else if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "not_available";
    const head = (await fs.readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40,64}$/u.test(head)) return head;
    const reference = head.match(/^ref: (refs\/[A-Za-z0-9._/-]+)$/u)?.[1];
    if (reference === undefined || reference.split("/").includes("..")) return "not_available";
    const direct = (await fs.readFile(path.join(gitDirectory, reference), "utf8").catch(() => "")).trim();
    if (/^[0-9a-f]{40,64}$/u.test(direct)) return direct;
    const packed = await fs.readFile(path.join(gitDirectory, "packed-refs"), "utf8").catch(() => "");
    const match = packed.match(new RegExp(`^([0-9a-f]{40,64}) ${reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    return match?.[1] ?? "not_available";
  } catch {
    return "not_available";
  }
}

async function validateFinalOwnership(result, { onlySlices = null } = {}) {
  const owners = new Map();
  const trustedRoot = await trustedProjectRoot(result.workspace);
  for (const row of result.rows) {
    if (!SUCCESS_RESULTS.has(row.result)) continue;
    if (onlySlices !== null && !onlySlices.has(row.slice)) continue;
    const task = result.tasks.get(row.slice);
    const taskDirectory = path.join(result.workspace.executionRoot, "tasks");
    const manifestTargets = new Set();
    const manifestPhysicalFiles = new Set();
    for (const entry of task.base.entries) {
      const target = path.resolve(taskDirectory, entry.path);
      await rejectSymlinkComponents(target, trustedRoot);
      if (manifestTargets.has(target)) throw new ExecutionContractError(`${row.slice} manifest aliases the same path: ${entry.path}`);
      manifestTargets.add(target);
      const metadata = await lstatOrNull(target);
      if (metadata !== null && metadata.isFile() && !metadata.isSymbolicLink()) {
        const physicalIdentity = `${metadata.dev}:${metadata.ino}`;
        if (manifestPhysicalFiles.has(physicalIdentity)) {
          throw new ExecutionContractError(`${row.slice} manifest paths alias the same physical file: ${entry.path}`);
        }
        manifestPhysicalFiles.add(physicalIdentity);
      }
      owners.set(target, { ...entry, slice: row.slice, target });
    }
  }
  const findings = [];
  for (const owner of owners.values()) {
    const metadata = await lstatOrNull(owner.target);
    if (owner.expected === "REMOVED") {
      if (metadata !== null) findings.push(`${owner.target} (${owner.slice}: expected REMOVED)`);
      continue;
    }
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current absent/non-file)`);
      continue;
    }
    const actual = createHash("sha256").update(await fs.readFile(owner.target)).digest("hex");
    if (actual !== owner.hash) findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current sha256:${actual})`);
  }
  if (findings.length !== 0) throw new ExecutionContractError("final validation ownership does not match the workspace", findings);
}

function validateTerminalOverlapDeclarations(result, { onlySlices = null } = {}) {
  for (const row of result.rows) {
    if (!SUCCESS_RESULTS.has(row.result) || (onlySlices !== null && !onlySlices.has(row.slice))) continue;
    const task = result.tasks.get(row.slice);
    if (task.evidenceContract !== "stnl-validation-evidence/v1") continue;
    const rowIndex = result.rows.indexOf(row);
    const expected = new Map();
    for (const priorRow of result.rows.slice(0, rowIndex)) {
      if (!SUCCESS_RESULTS.has(priorRow.result)) continue;
      const prior = result.tasks.get(priorRow.slice);
      const paths = task.changedClaims.filter((claim) => prior.base.paths.includes(claim));
      if (paths.length !== 0) expected.set(priorRow.slice, paths.sort((a, b) => a.localeCompare(b, "en")));
    }
    const declared = new Map();
    for (const overlap of task.priorValidationOverlaps) {
      if (overlap.priorSlice === row.slice || declared.has(overlap.priorSlice)) {
        throw new ExecutionContractError(`${row.slice} has duplicate or self-referential Prior Validation Overlap`);
      }
      declared.set(overlap.priorSlice, overlap.paths);
    }
    if (expected.size !== declared.size) {
      throw new ExecutionContractError(`${row.slice} Prior Validation Overlap does not declare every changed terminal-base intersection`);
    }
    for (const [slice, paths] of expected) {
      if (JSON.stringify(declared.get(slice)) !== JSON.stringify(paths)) {
        throw new ExecutionContractError(`${row.slice} Prior Validation Overlap is incomplete or stale for ${slice}`);
      }
    }
  }
}

function markdownStructuralText(text) {
  let fence = null;
  let inHtmlComment = false;
  return String(text).split("\n").map((rawLine) => {
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, "u");
      if (close.test(rawLine)) fence = null;
      return "";
    }

    let visible = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inHtmlComment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end === -1) return visible;
        inHtmlComment = false;
        visible += " ";
        cursor = end + 3;
      } else {
        const start = rawLine.indexOf("<!--", cursor);
        if (start === -1) {
          visible += rawLine.slice(cursor);
          break;
        }
        visible += `${rawLine.slice(cursor, start)} `;
        inHtmlComment = true;
        cursor = start + 4;
      }
    }

    const opening = visible.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (opening !== null) {
      fence = { character: opening[1][0], length: opening[1].length };
      return "";
    }
    return visible;
  }).join("\n");
}

function parseCanonicalReferenceList(value, label, { permitNone = false } = {}) {
  const normalized = normalizeText(value);
  if (permitNone && new Set(["-", "- none", "none"]).has(normalized.toLowerCase())) return [];
  if (normalized.length === 0 || /^(?:-|none)$/iu.test(normalized)) {
    throw new ExecutionContractError(`${label} must contain at least one canonical authority reference`);
  }
  const tokens = normalized.split(/\n|,/u).map((entry) => entry.trim().replace(/^[-*]\s+/u, "").replace(/[.;:]$/u, ""))
    .filter((entry) => entry.length !== 0);
  if (tokens.length === 0 || tokens.some((token) => !CANONICAL_AUTHORITY_REFERENCE.test(token))) {
    throw new ExecutionContractError(`${label} has malformed canonical authority references`);
  }
  const references = [...new Set(tokens)].sort((left, right) => left.localeCompare(right, "en"));
  if (references.length !== tokens.length) throw new ExecutionContractError(`${label} has duplicate authority references`);
  return references;
}

function parseDependencyList(value, label) {
  const normalized = normalizeText(value);
  const sentinel = normalized.replace(/[.;:]$/u, "").toLowerCase();
  if (new Set(["", "-", "- none", "none"]).has(sentinel)) return [];
  const tokens = normalized.split(/\n|,/u).map((entry) => entry.trim().replace(/^[-*]\s+/u, "").replace(/[.;:]$/u, ""))
    .filter((entry) => entry.length !== 0);
  const dependencies = tokens.map((token) => {
    const match = token.match(/^(?:slice-)?([0-9]+)$/u);
    if (match === null) throw new ExecutionContractError(`${label} has malformed slice dependency: ${token}`);
    return `slice-${match[1].padStart(2, "0")}`;
  });
  const unique = [...new Set(dependencies)].sort((left, right) => left.localeCompare(right, "en"));
  if (unique.length !== dependencies.length) throw new ExecutionContractError(`${label} has duplicate slice dependencies`);
  return unique;
}

function validateSliceDependencyGraph(sliceOrder, sliceRows, label = "Serial Slice Order") {
  const known = new Set(sliceOrder);
  const visiting = new Set();
  const visited = new Set();
  function visit(slice) {
    if (visiting.has(slice)) throw new ExecutionContractError(`${label} contains a circular dependency involving ${slice}`);
    if (visited.has(slice)) return;
    visiting.add(slice);
    for (const dependency of sliceRows.get(slice).dependencies) visit(dependency);
    visiting.delete(slice);
    visited.add(slice);
  }
  for (const [slice, row] of sliceRows) {
    for (const dependency of row.dependencies) {
      if (!known.has(dependency)) throw new ExecutionContractError(`${label} references unknown dependency ${dependency} from ${slice}`);
      if (dependency === slice) throw new ExecutionContractError(`${label} has a self-dependency on ${slice}`);
    }
  }
  for (const slice of sliceOrder) visit(slice);
  const positions = new Map(sliceOrder.map((slice, index) => [slice, index]));
  for (const [slice, row] of sliceRows) {
    for (const dependency of row.dependencies) {
      if (positions.get(dependency) >= positions.get(slice)) {
        throw new ExecutionContractError(`${label} dependency ${dependency} for ${slice} must appear earlier in Serial Slice Order`);
      }
    }
  }
}

async function validatePlanCoverage({ workspace, globalPlan, sliceOrder, sliceRows, plans, currentFingerprint, authority = null }) {
  if (globalPlan.fingerprint !== currentFingerprint) return authority;
  const coverageAuthority = authority ?? await authorityReferenceSets(workspace);
  if (coverageAuthority.known.size === 0) return coverageAuthority;
  const currentSlices = sliceOrder.filter((slice) => plans.get(slice)?.fingerprint === globalPlan.fingerprint);
  const covered = new Set(currentSlices.flatMap((slice) => sliceRows.get(slice).requirements));
  for (const reference of covered) {
    if (!coverageAuthority.known.has(reference)) {
      throw new ExecutionContractError(`current plan references unknown authority ${reference}`);
    }
    if (!coverageAuthority.active.has(reference)) {
      throw new ExecutionContractError(`current plan references inactive authority ${reference}`);
    }
  }
  const missing = [...coverageAuthority.required].filter((reference) => !covered.has(reference));
  if (missing.length !== 0) {
    throw new ExecutionContractError(`current plan coverage omits authority ${missing.join(", ")}`);
  }
  return coverageAuthority;
}

function validateTaskAuthorityCoverage(task, authority, sliceRequirements, label) {
  const taskReferences = new Set(task.coverageReferences);
  for (const reference of taskReferences) {
    if (!authority.known.has(reference)) {
      throw new ExecutionContractError(`${label} references unknown authority ${reference}`);
    }
    if (!authority.active.has(reference)) {
      throw new ExecutionContractError(`${label} references inactive authority ${reference}`);
    }
    if (!sliceRequirements.includes(reference)) {
      throw new ExecutionContractError(`${label} references authority ${reference} outside approved Slice coverage`);
    }
  }
  const missing = sliceRequirements.filter((reference) => !taskReferences.has(reference));
  if (missing.length !== 0) {
    throw new ExecutionContractError(`${label} task coverage omits authority ${missing.join(", ")}`);
  }
}

function parseGlobalRows(text) {
  const { header, body } = parsePurpose(text, "tasks.md");
  if (header.get("owner") !== "stnl-task-materializer" || header.get("status") !== "ready") {
    throw new ExecutionContractError("tasks.md has an invalid File Purpose Header owner or status");
  }
  const structuralBody = markdownStructuralText(body);
  if (!structuralBody.startsWith("# Execution Tasks\n\n")
    || (structuralBody.match(/^# /gmu) ?? []).length !== 1 || /^## /gmu.test(structuralBody)) {
    throw new ExecutionContractError("tasks.md has a non-canonical heading structure");
  }
  const tableHeader = "| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |";
  const table = canonicalTableRows(
    structuralBody,
    tableHeader,
    "|---|---|---|---|---|---|---|",
    "tasks.md",
    { permitProseOutside: true },
  );
  const rows = [];
  for (const line of table) {
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length !== 7 || !/^\[[ x]\]$/u.test(columns[0])) throw new ExecutionContractError(`tasks.md has malformed row: ${line}`);
    const sliceMatch = columns[1].match(/^([0-9]{2,}) - \S.*$/u);
    if (sliceMatch === null || columns[4] !== `tasks/slice-${sliceMatch[1]}.md`) throw new ExecutionContractError(`tasks.md has malformed slice mapping: ${line}`);
    rows.push({
      done: columns[0] === "[x]",
      slice: `slice-${sliceMatch[1]}`,
      dependencies: parseDependencyList(columns[3], `tasks.md ${sliceMatch[1]} Dependencies`),
      validation: columns[5],
      result: columns[6],
    });
  }
  if (rows.length === 0) throw new ExecutionContractError("tasks.md has no slice rows");
  if (new Set(rows.map((row) => row.slice)).size !== rows.length) throw new ExecutionContractError("tasks.md has duplicate slice rows");
  return rows;
}

function rowLikeTableResidue(line) {
  const value = line.trimStart();
  const pipes = (value.match(/\|/gu) ?? []).length;
  return value.startsWith("|")
    || /^\[[ x]\]\s*\|/u.test(value)
    || /^---+\s*\|/u.test(value)
    || /^Done\s*\|\s*Slice\s*\|/u.test(value)
    || (pipes >= 3 && /tasks\/slice-[0-9]{2,}\.md/u.test(value));
}

function canonicalTableRows(section, header, separator, label, { allowedOutside = new Set(), permitProseOutside = false } = {}) {
  const lines = String(section).split("\n");
  const headerIndexes = lines.flatMap((line, index) => line === header ? [index] : []);
  if (headerIndexes.length !== 1 || lines[headerIndexes[0] + 1] !== separator) {
    throw new ExecutionContractError(`${label} has a malformed canonical table header`);
  }
  const start = headerIndexes[0] + 2;
  let end = start;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;
  const rows = lines.slice(start, end);
  const unexpected = lines.some((line, index) => line.length !== 0
    && index !== headerIndexes[0] && index !== headerIndexes[0] + 1
    && (index < start || index >= end)
    && (permitProseOutside ? rowLikeTableResidue(line) : !allowedOutside.has(line)));
  if (unexpected) throw new ExecutionContractError(`${label} has an unexpected structural row`);
  if (rows.length === 0) throw new ExecutionContractError(`${label} has no canonical data rows`);
  return rows;
}

function requirementsReference(workspace, directory) {
  return path.relative(directory, workspace.authorityPath).split(path.sep).join("/");
}

async function readPlanArtifacts(workspace, { currentFingerprint = null } = {}) {
  const globalPlanPath = path.join(workspace.executionRoot, "plan.md");
  await requireRealFile(globalPlanPath, "execution plan.md");
  const globalPlanText = await fs.readFile(globalPlanPath, "utf8");
  const globalPlan = parsePlan(globalPlanText, "plan.md", null, {
    requirementsSource: requirementsReference(workspace, workspace.executionRoot),
  });
  const serialOrder = globalPlan.sections.get("Serial Slice Order");
  const serialRows = canonicalTableRows(
    serialOrder,
    "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |",
    "|---|---|---|---|---|---|",
    "Serial Slice Order",
  );
  const serialEntries = serialRows.map((line) => {
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length !== 6) throw new ExecutionContractError(`Serial Slice Order has malformed row: ${line}`);
    const slice = columns[0].match(/^([0-9]{2,}) - \S.*$/u)?.[1];
    if (slice === undefined || columns[5] !== `plans/slice-${slice}.md`) {
      throw new ExecutionContractError(`Serial Slice Order has malformed row: ${line}`);
    }
    return {
      slice: `slice-${slice}`,
      dependencies: parseDependencyList(columns[2], `Serial Slice Order ${slice} Dependencies`),
      requirements: parseCanonicalReferenceList(columns[3], `Serial Slice Order ${slice} Requirements`),
    };
  });
  const sliceOrder = serialEntries.map((entry) => entry.slice);
  if (new Set(sliceOrder).size !== sliceOrder.length) throw new ExecutionContractError("plan.md has missing or duplicate detailed plan mappings");
  const sliceRows = new Map(serialEntries.map((entry) => [entry.slice, entry]));
  validateSliceDependencyGraph(sliceOrder, sliceRows);
  const plans = new Map();
  const planDirectory = path.join(workspace.executionRoot, "plans");
  const directoryFindings = [];
  const actualPlanNames = await inspectSliceDirectory(planDirectory, directoryFindings, { required: true });
  if (directoryFindings.length !== 0) {
    throw new ExecutionContractError(`execution layout contains non-canonical paths: ${directoryFindings.join(", ")}`, directoryFindings);
  }
  const expectedPlanNames = sliceOrder.map((slice) => `${slice}.md`).sort();
  if (actualPlanNames.length !== expectedPlanNames.length
    || actualPlanNames.some((name, index) => name !== expectedPlanNames[index])) {
    throw new ExecutionContractError("plans directory does not exactly match the current Serial Slice Order");
  }
  for (const slice of sliceOrder) {
    const detailedPath = path.join(planDirectory, `${slice}.md`);
    await requireRealFile(detailedPath, `${slice} detailed plan`);
    const plan = parsePlan(await fs.readFile(detailedPath, "utf8"), `${slice} plan`, slice, {
      requirementsSource: requirementsReference(workspace, planDirectory),
    });
    const detailRequirements = parseCanonicalReferenceList(plan.sections.get("Requirements"), `${slice} plan Requirements`);
    const detailDependencies = parseDependencyList(plan.sections.get("Dependencies"), `${slice} plan Dependencies`);
    const globalRow = sliceRows.get(slice);
    if (JSON.stringify(detailRequirements) !== JSON.stringify(globalRow.requirements)) {
      throw new ExecutionContractError(`${slice} detailed plan Requirements disagree with Serial Slice Order`);
    }
    if (JSON.stringify(detailDependencies) !== JSON.stringify(globalRow.dependencies)) {
      throw new ExecutionContractError(`${slice} detailed plan Dependencies disagree with Serial Slice Order`);
    }
    plans.set(slice, plan);
  }
  const effectiveFingerprint = currentFingerprint ?? await computeRequirementsAuthority(workspace.authorityPath);
  const authority = globalPlan.fingerprint === effectiveFingerprint ? await authorityReferenceSets(workspace) : null;
  await validatePlanCoverage({
    workspace,
    globalPlan,
    sliceOrder,
    sliceRows,
    plans,
    currentFingerprint: effectiveFingerprint,
    authority,
  });
  return { globalPlan, globalPlanText, sliceOrder, sliceRows, plans, authority };
}

async function executionArtifacts(workspace, currentFingerprint = null) {
  const { globalPlan, sliceOrder, sliceRows, plans, authority } = await readPlanArtifacts(workspace, { currentFingerprint });
  const tasksIndexPath = path.join(workspace.executionRoot, "tasks.md");
  await requireRealFile(tasksIndexPath, "execution tasks.md");
  const tasksIndexText = await fs.readFile(tasksIndexPath, "utf8");
  const rows = parseGlobalRows(tasksIndexText);
  const tasks = new Map();
  const pairMismatches = [];
  for (const row of rows) {
    const taskDirectory = path.join(workspace.executionRoot, "tasks");
    const taskPath = path.join(taskDirectory, `${row.slice}.md`);
    await requireRealFile(taskPath, `${row.slice} detailed task`);
    const task = parseTask(await fs.readFile(taskPath, "utf8"), taskPath, row.slice, {
      requirementsSource: requirementsReference(workspace, taskDirectory),
    });
    const planRow = sliceRows.get(row.slice);
    if (JSON.stringify(row.dependencies) !== JSON.stringify(planRow.dependencies)) {
      throw new ExecutionContractError(`${row.slice} task index Dependencies disagree with Serial Slice Order`);
    }
    const plan = plans.get(row.slice);
    if (plan !== undefined && (task.fingerprint !== plan.fingerprint || task.revision !== plan.revision)) pairMismatches.push(row.slice);
    if (authority !== null && plan !== undefined && plan.fingerprint === globalPlan.fingerprint && task.fingerprint === plan.fingerprint) {
      validateTaskAuthorityCoverage(task, authority, planRow.requirements, row.slice);
    }
    if (row.done && SUCCESS_RESULTS.has(row.result)) {
      if (row.validation !== row.result || task.final.result !== row.result) throw new ExecutionContractError(`${row.slice} PASS/ACCEPTED row and detailed task disagree`);
    } else if (row.done && row.result === "SUPERSEDED") {
      if (row.validation !== "SUPERSEDED" || task.final.result !== "SUPERSEDED") throw new ExecutionContractError(`${row.slice} SUPERSEDED row and detailed task disagree`);
    } else if (row.done || row.validation !== "pending" || row.result !== "pending" || task.final.result !== "pending") {
      throw new ExecutionContractError(`${row.slice} global and detailed state disagree`);
    }
    if (globalPlan.revisionMode === null && !row.done && (task.fingerprint !== globalPlan.fingerprint || task.revision !== globalPlan.revision)) {
      throw new ExecutionContractError(`${row.slice} open slice is stale relative to current global authority`);
    }
    tasks.set(row.slice, task);
  }
  const trustedRoot = await trustedProjectRoot(workspace);
  const taskDirectory = path.join(workspace.executionRoot, "tasks");
  for (const [slice, task] of tasks) {
    for (const claim of task.claims) {
      await rejectSymlinkComponents(path.resolve(taskDirectory, claim), trustedRoot).catch((error) => {
        throw new ExecutionContractError(`${slice} contains an unsafe validation-owned path: ${claim}`, error.findings ?? []);
      });
    }
    for (const record of [...task.implementationChecks, ...task.findingsChecks]) {
      for (const entry of record.testedState) {
        await rejectSymlinkComponents(path.resolve(taskDirectory, entry.path), trustedRoot).catch((error) => {
          throw new ExecutionContractError(`${slice}:${record.id} contains an unsafe Tested state path: ${entry.path}`, error.findings ?? []);
        });
      }
    }
  }
  const mappingMismatch = rows.length !== sliceOrder.length || rows.some((row, index) => row.slice !== sliceOrder[index]);
  const currentPairMismatch = rows.some((row) => !row.done && (
    tasks.get(row.slice).fingerprint !== globalPlan.fingerprint || tasks.get(row.slice).revision !== globalPlan.revision
  ));
  const pendingReplan = globalPlan.revisionMode !== null && (mappingMismatch || pairMismatches.length !== 0 || currentPairMismatch);
  if (!pendingReplan && (globalPlan.status !== "ready" || [...plans.values()].some((plan) => plan.status !== "ready"))) {
    throw new ExecutionContractError("materialized planning artifacts must all be ready and approved");
  }
  if (globalPlan.revisionMode === null && (rows.length !== sliceOrder.length || rows.some((row, index) => row.slice !== sliceOrder[index]))) {
    throw new ExecutionContractError("plan/task slice mappings or serial order disagree");
  }
  if (globalPlan.revisionMode === null && pairMismatches.length !== 0) throw new ExecutionContractError(`${pairMismatches.join(", ")} plan/task authority does not agree`);
  if (pendingReplan) {
    const historicalRevision = Math.max(...tasks.values().map((task) => task.revision));
    if (globalPlan.revision !== historicalRevision + 1) throw new ExecutionContractError("pending REPLAN must increment Plan revision by exactly one");
    if (globalPlan.revisionMode === "pristine-replacement" && [...tasks.values()].some((task) => !task.pristine)) {
      throw new ExecutionContractError("pristine replacement retains operational task evidence");
    }
    if (globalPlan.revisionMode === "pristine-replacement" && globalPlan.supersessionMappings.length !== 0) {
      throw new ExecutionContractError("pristine replacement cannot supersede execution history");
    }
    if (globalPlan.revisionMode === "pristine-replacement" && [...plans.values()].some((plan) => (
      plan.fingerprint !== globalPlan.fingerprint || plan.revision !== globalPlan.revision || plan.status !== globalPlan.status
    ))) {
      throw new ExecutionContractError("pristine replacement candidate plans do not all match the proposed authority and revision");
    }
    if (globalPlan.revisionMode === "append-only-extension") {
      if (pairMismatches.length !== 0) throw new ExecutionContractError("append-only extension changed historical plan/task authority");
      if (rows.some((row) => !plans.has(row.slice))) throw new ExecutionContractError("append-only extension removed a historical plan");
      const lastHistorical = Math.max(...rows.map((row) => Number(row.slice.slice("slice-".length))));
      const appended = sliceOrder.filter((slice) => !tasks.has(slice));
      if (appended.length === 0 || appended.some((slice) => Number(slice.slice("slice-".length)) <= lastHistorical)) {
        throw new ExecutionContractError("append-only extension lacks monotonically appended plan slices");
      }
      if (rows.some((row) => plans.get(row.slice)?.status !== "ready")
        || appended.some((slice) => plans.get(slice).status !== globalPlan.status)) {
        throw new ExecutionContractError("append-only candidate and historical plan review states disagree");
      }
      for (const { source, target } of globalPlan.supersessionMappings) {
        const sourceRow = rows.find((row) => row.slice === source);
        if (sourceRow === undefined || sourceRow.done) throw new ExecutionContractError(`supersession source ${source} is not an open historical slice`);
        if (!appended.includes(target) || sliceOrder.indexOf(target) <= sliceOrder.indexOf(source)) {
          throw new ExecutionContractError(`supersession target ${target} is not a newly appended later slice`);
        }
      }
      const staleOpen = rows.filter((row) => !row.done && (
        tasks.get(row.slice).fingerprint !== globalPlan.fingerprint || tasks.get(row.slice).revision !== globalPlan.revision
      )).map((row) => row.slice);
      const mappedSources = new Set(globalPlan.supersessionMappings.map(({ source }) => source));
      if (staleOpen.some((slice) => !mappedSources.has(slice))) throw new ExecutionContractError("REPLAN does not supersede every prior-revision open slice");
    }
    for (const slice of sliceOrder) {
      const plan = plans.get(slice);
      if (!tasks.has(slice) && (plan.fingerprint !== globalPlan.fingerprint || plan.revision !== globalPlan.revision)) {
        throw new ExecutionContractError(`${slice} pending plan is stale relative to the proposed revision`);
      }
    }
  }
  if (globalPlan.revisionMode !== null && !pendingReplan) {
    const materializedRevision = Math.max(...tasks.values().map((task) => task.revision));
    if (globalPlan.revision !== materializedRevision) throw new ExecutionContractError("committed REPLAN revision disagrees with materialized tasks");
    if (globalPlan.revisionMode === "pristine-replacement" && globalPlan.supersessionMappings.length !== 0) {
      throw new ExecutionContractError("committed pristine replacement contains supersession mappings");
    }
    if (globalPlan.revisionMode === "pristine-replacement" && (globalPlan.revision < 2 || [...tasks.values()].some((task) => task.revision !== globalPlan.revision))) {
      throw new ExecutionContractError("committed pristine replacement has invalid materialized revision history");
    }
    if (globalPlan.revisionMode === "append-only-extension") {
      if (![...tasks.values()].some((task) => task.revision < globalPlan.revision)
        || ![...tasks.values()].some((task) => task.revision === globalPlan.revision)) {
        throw new ExecutionContractError("committed append-only extension lacks historical and current-revision tasks");
      }
      for (const { source, target } of globalPlan.supersessionMappings) {
        const sourceRow = rows.find((row) => row.slice === source);
        const targetTask = tasks.get(target);
        if (sourceRow?.result !== "SUPERSEDED" || tasks.get(source)?.final.supersededBy !== target
          || targetTask === undefined || targetTask.revision !== globalPlan.revision) {
          throw new ExecutionContractError(`${source} -> ${target} is not a committed supersession mapping`);
        }
      }
      const declaredMappings = new Set(globalPlan.supersessionMappings.map(({ source, target }) => `${source} -> ${target}`));
      const committedMappings = new Set(rows.filter((row) => row.result === "SUPERSEDED"
        && tasks.get(row.slice).final.planRevision === globalPlan.revision)
        .map((row) => `${row.slice} -> ${tasks.get(row.slice).final.supersededBy}`));
      if (declaredMappings.size !== committedMappings.size || [...declaredMappings].some((mapping) => !committedMappings.has(mapping))) {
        throw new ExecutionContractError("current-revision committed supersessions do not exactly match the global mappings");
      }
    }
  }
  if (globalPlan.revisionMode === null && globalPlan.revision !== 1) throw new ExecutionContractError("initial materialized plan must use Plan revision 1");
  const firstOpenIndex = rows.findIndex((row) => !row.done);
  if (!pendingReplan && firstOpenIndex >= 0) {
    for (const later of rows.slice(firstOpenIndex + 1)) {
      if (later.done || !tasks.get(later.slice).pristine) {
        throw new ExecutionContractError(`${later.slice} contains operational state after the serial frontier ${rows[firstOpenIndex].slice}`);
      }
    }
  }
  const supersededUnowned = [];
  for (const row of rows.filter((candidate) => candidate.result === "SUPERSEDED")) {
    const replacement = tasks.get(row.slice).final.supersededBy;
    const replacementIndex = sliceOrder.indexOf(replacement);
    if (!tasks.has(replacement) || replacementIndex <= sliceOrder.indexOf(row.slice)) throw new ExecutionContractError(`${row.slice} has an invalid later replacement slice`);
    if (tasks.get(row.slice).final.planRevision !== tasks.get(replacement).revision
      || tasks.get(row.slice).final.planRevision > globalPlan.revision) {
      throw new ExecutionContractError(`${row.slice} SUPERSEDED Final Result does not name its replacement's committing Plan revision`);
    }
    const laterOwned = new Set(rows.slice(replacementIndex).filter((candidate) => SUCCESS_RESULTS.has(candidate.result)).flatMap((candidate) => tasks.get(candidate.slice).base.paths));
    const unowned = tasks.get(row.slice).claims.filter((claim) => !laterOwned.has(claim));
    supersededUnowned.push(...unowned.map((claim) => `${row.slice}:${claim}`));
  }
  for (const row of rows) {
    const task = tasks.get(row.slice);
    if (row.result === "SUPERSEDED" && task.divergences.some((record) => record.severity === "blocking" && record.state === "active")) {
      throw new ExecutionContractError(`${row.slice} SUPERSEDED history retains an undisposed blocking divergence`);
    }
    for (const divergence of task.divergences.filter((record) => record.severity === "blocking" && record.state === "resolved" && record.revalidationRecord === undefined)) {
      const owner = tasks.get(divergence.resolutionSlice);
      if (row.result !== "SUPERSEDED" || task.final.supersededBy !== divergence.resolutionSlice || owner === undefined
        || owner.revision !== divergence.resolutionRevision || divergence.resolutionRevision > globalPlan.revision) {
        throw new ExecutionContractError(`${row.slice}:${divergence.id} resolution has no committed supersession owner`);
      }
    }
    for (const divergence of task.divergences.filter((record) => record.severity === "blocking" && record.state === "superseded")) {
      const replacement = task.divergences.find((record) => record.id === field(divergence.body, "Superseded by"));
      const recoverySlice = tasks.get(task.final.supersededBy);
      if (row.result !== "SUPERSEDED" || recoverySlice === undefined
        || task.final.planRevision !== recoverySlice.revision || replacement === undefined) {
        throw new ExecutionContractError(`${row.slice}:${divergence.id} supersession has no committed recovery owner`);
      }
    }
  }
  return { globalPlan, plans, tasks, rows, sliceOrder, pendingReplan, supersededUnowned };
}

export async function inspectExecutionState(specPath) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const currentFingerprint = await computeRequirementsAuthority(specPath);
  const rootMetadata = await lstatOrNull(workspace.executionRoot);
  if (rootMetadata === null) {
    await rejectOfficialLifecycleRootExecution(workspace);
    const lifecycleStatus = await lifecycleStatusForExecution(workspace);
    return withRecoveryTargets({ state: "EMPTY", workspace, currentFingerprint, lifecycleStatus });
  }
  const nonIgnored = (await fs.readdir(workspace.executionRoot, { withFileTypes: true })).filter((entry) => !isIgnoredMetadata(entry.name));
  if (nonIgnored.length === 0) {
    await rejectOfficialLifecycleRootExecution(workspace);
    const lifecycleStatus = await lifecycleStatusForExecution(workspace);
    return withRecoveryTargets({ state: "EMPTY", workspace, currentFingerprint, lifecycleStatus });
  }
  const hasTasks = await lstatOrNull(path.join(workspace.executionRoot, "tasks.md")) !== null;
  await validateExecutionLayout(specPath, { allowPlanned: !hasTasks });
  if (!hasTasks) {
    const { globalPlan, plans } = await readPlanArtifacts(workspace, { currentFingerprint });
    if (globalPlan.revisionMode === null && globalPlan.revision !== 1) {
      throw new ExecutionContractError("planning-only authority must use Plan revision 1, including replacement by REPLAN");
    }
    if (globalPlan.revisionMode !== null) {
      throw new ExecutionContractError("planning-only REPLAN must omit historical recovery revision fields until tasks have been materialized");
    }
    if ([...plans.values()].some((plan) => plan.fingerprint !== globalPlan.fingerprint || plan.revision !== globalPlan.revision)) {
      throw new ExecutionContractError("detailed plans do not match the global planning authority and revision");
    }
    if (globalPlan.status === "ready" && [...plans.values()].some((plan) => plan.status !== "ready")) {
      throw new ExecutionContractError("ready global plan retains a draft detailed plan");
    }
    const stale = globalPlan.fingerprint !== currentFingerprint;
    const state = stale ? "REQUIREMENTS_CHANGED" : globalPlan.status === "ready" ? "PLANNED_READY" : "PLANNED_DRAFT";
    return withRecoveryTargets({ state, workspace, currentFingerprint, globalPlan, stale });
  }
  const artifacts = await executionArtifacts(workspace, currentFingerprint);
  const stale = artifacts.globalPlan.fingerprint !== currentFingerprint;
  const allPristine = artifacts.rows.every((row) => !row.done && artifacts.tasks.get(row.slice).pristine);
  if (artifacts.pendingReplan) {
    const pendingStale = artifacts.globalPlan.fingerprint !== currentFingerprint;
    const state = pendingStale ? "REQUIREMENTS_CHANGED"
      : artifacts.globalPlan.status === "ready" ? "PENDING_REPLAN_READY" : "PENDING_REPLAN_DRAFT";
    return withRecoveryTargets({ state, workspace, currentFingerprint, stale: pendingStale, ...artifacts });
  }
  const effectiveSlices = artifacts.rows.filter((row) => row.result !== "SUPERSEDED").map((row) => row.slice);
  const activeFindings = effectiveSlices.flatMap((slice) => artifacts.tasks.get(slice).activeBlockers.filter((record) => record.id.startsWith("finding-")).map((record) => `${slice}:${record.id}`));
  const activeDivergences = effectiveSlices.flatMap((slice) => artifacts.tasks.get(slice).divergences
    .filter((record) => record.severity === "blocking" && record.state === "active")
    .map((record) => Object.freeze({ slice, record: record.id, requiredAuthorityOperation: record.requiredAuthorityOperation })));
  const activeDelegationBlockers = effectiveSlices.flatMap((slice) => {
    const blocker = artifacts.tasks.get(slice).delegationBlocker;
    return blocker?.state === "active" ? [{ slice, ...blocker }] : [];
  });
  if (activeDelegationBlockers.length > 1) throw new ExecutionContractError("multiple active Delegation Blockers make resume ambiguous");
  const exhausted = effectiveSlices.map((slice) => [slice, artifacts.tasks.get(slice).retryExhausted]).filter(([, value]) => value !== null);
  const incompleteExecutionChecklists = effectiveSlices.flatMap((slice) => {
    const task = artifacts.tasks.get(slice);
    const record = task.implementationChecks.at(-1);
    const handsOffToValidation = SUCCESS_CHECKS.has(record?.status)
      || (record?.status === "TESTS_FAIL" && record.round === 3);
    return task.attempts.length === 0 && !task.checklistComplete && handsOffToValidation
      ? [{ slice, record: record.id, round: record.round, status: record.status }]
      : [];
  });
  if (incompleteExecutionChecklists.length > 1) {
    throw new ExecutionContractError("multiple incomplete execution finalizations make recovery ambiguous");
  }
  const validationBlocked = effectiveSlices.filter((slice) => artifacts.tasks.get(slice).attempts.at(-1)?.status === "BLOCKED");
  const auxiliaryBlocked = effectiveSlices.flatMap((slice) => {
    const task = artifacts.tasks.get(slice);
    const latestAttempt = task.attempts.at(-1);
    const implementation = task.implementationChecks.at(-1);
    const findings = task.findingsChecks.at(-1);
    if (latestAttempt === undefined && implementation?.status === "BLOCKED") return [{ slice, operation: "EXECUTE_SLICE", record: implementation.id, round: implementation.round }];
    if (latestAttempt?.status === "NEEDS_FIX" && findings?.status === "BLOCKED" && findings.findingsCycle === latestAttempt.id) {
      return [{ slice, operation: "APPLY_FINDINGS", record: findings.id, round: findings.round }];
    }
    return [];
  });
  if (auxiliaryBlocked.length > 1) throw new ExecutionContractError("multiple current auxiliary blockers make resume ambiguous");
  const findingsCorrected = effectiveSlices.filter((slice) => {
    const task = artifacts.tasks.get(slice);
    const latestAttempt = task.attempts.at(-1);
    const latestCheck = task.findingsChecks.at(-1);
    return latestAttempt?.status === "NEEDS_FIX" && latestCheck?.findingsCycle === latestAttempt.id
      && SUCCESS_CHECKS.has(latestCheck.status);
  });
  const implementedAwaitingValidation = effectiveSlices.filter((slice) => {
    const task = artifacts.tasks.get(slice);
    return task.attempts.length === 0 && SUCCESS_CHECKS.has(task.implementationChecks.at(-1)?.status);
  });
  const allTerminal = artifacts.rows.every((row) => row.done && new Set(["PASS", "ACCEPTED", "SUPERSEDED"]).has(row.result));
  if (allTerminal && artifacts.supersededUnowned.length !== 0) {
    throw new ExecutionContractError(`SUPERSEDED paths lack later PASS/ACCEPTED ownership: ${artifacts.supersededUnowned.join(", ")}`);
  }
  const currentPass = artifacts.rows.some((row) => SUCCESS_RESULTS.has(row.result)
    && artifacts.tasks.get(row.slice).fingerprint === artifacts.globalPlan.fingerprint
    && artifacts.tasks.get(row.slice).revision === artifacts.globalPlan.revision);
  let state = "EXECUTION_STARTED";
  if (stale) state = "REQUIREMENTS_CHANGED";
  else if (activeDivergences.length !== 0) state = "DIVERGENCE_BLOCKED";
  else if (activeDelegationBlockers.length !== 0) state = activeDelegationBlockers[0].kind === "initialization" ? "RUNNER_INITIALIZATION_BLOCKED" : "RUNNER_RESULT_BLOCKED";
  else if (exhausted.length !== 0) state = exhausted.some(([, value]) => value === "FINDINGS") ? "FINDINGS_RETRY_EXHAUSTED" : "IMPLEMENTATION_RETRY_EXHAUSTED";
  else if (auxiliaryBlocked.length !== 0) state = "AUXILIARY_BLOCKED";
  else if (findingsCorrected.length !== 0) state = "FINDINGS_CORRECTED";
  else if (implementedAwaitingValidation.length !== 0) state = "IMPLEMENTED_AWAITING_VALIDATION";
  else if (validationBlocked.length !== 0) state = "VALIDATION_BLOCKED";
  else if (activeFindings.length !== 0) state = "VALIDATION_NEEDS_FIX";
  else if (allPristine) state = "MATERIALIZED_PRISTINE";
  else if (allTerminal && currentPass) state = "COMPLETE";
  else if (allTerminal) state = "REPLAN_REQUIRED";
  return withRecoveryTargets({
    state, workspace, currentFingerprint, stale, activeFindings, activeDivergences, activeDelegationBlockers,
    exhausted, incompleteExecutionChecklists, auxiliaryBlocked, findingsCorrected, implementedAwaitingValidation,
    validationBlocked, ...artifacts,
  });
}

function recoveryTarget(operation, {
  slice = null,
  owner = "execution-state",
  record = null,
  round = null,
  retryState = null,
  authorityMode = null,
  invocation = null,
  sameOperationResumeRequired = false,
} = {}) {
  return { operation, slice, owner, record, round, retryState, authorityMode, invocation, sameOperationResumeRequired };
}

function uniqueRecoveryTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = [
      target.operation, target.slice, target.owner, target.record, target.round, target.retryState,
      target.authorityMode, target.invocation, target.sameOperationResumeRequired,
    ].map((value) => value ?? "").join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentFrontier(result) {
  return result.rows?.find((row) => !row.done)?.slice ?? null;
}

function hasGateReplanEvidence(result) {
  return [...result.tasks?.values() ?? []].some((task) => task.final.result === "pending"
    && chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts).at(-1)?.gates.some((gate) => gate.decision === "replan"));
}

export function deriveRecoveryTargets(result) {
  const unscoped = (operation, owner = "execution-state") => recoveryTarget(operation, { owner });
  const scoped = (operation, slice, options = {}) => recoveryTarget(operation, { slice, ...options });
  const incompleteExecution = result.incompleteExecutionChecklists?.[0];
  const validationDelegationBlocked = new Set(["RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"]).has(result.state)
    && result.activeDelegationBlockers?.[0]?.operation === "VALIDATE_SLICE";
  if (incompleteExecution !== undefined && (
    new Set(["IMPLEMENTED_AWAITING_VALIDATION", "IMPLEMENTATION_RETRY_EXHAUSTED"]).has(result.state)
    || validationDelegationBlocked
  )) {
    return [scoped("EXECUTE_SLICE", incompleteExecution.slice, {
      owner: "stnl-slice-executor",
      record: incompleteExecution.record,
      round: incompleteExecution.round,
      sameOperationResumeRequired: true,
    })];
  }
  let targets = [];
  switch (result.state) {
    case "EMPTY":
      targets = result.workspace.kind === "standalone" || result.lifecycleStatus === "ready"
        ? [unscoped("PLAN", "empty-workspace")] : [];
      break;
    case "PLANNED_DRAFT": targets = [unscoped("REVIEW_PLAN", "planning-authority"), unscoped("REPLAN", "planning-authority")]; break;
    case "PLANNED_READY": targets = [unscoped("MATERIALIZE_TASKS", "planning-authority"), unscoped("REPLAN", "planning-authority")]; break;
    case "PENDING_REPLAN_DRAFT": targets = [unscoped("REVIEW_PLAN", "pending-replan")]; break;
    case "PENDING_REPLAN_READY": targets = [unscoped("MATERIALIZE_TASKS", "pending-replan")]; break;
    case "MATERIALIZED_PRISTINE":
      targets = [
        unscoped("REVIEW_TASKS", "materialized-pristine"),
        scoped("EXECUTE_SLICE", currentFrontier(result), { owner: "serial-frontier" }),
        unscoped("REPLAN", "materialized-pristine"),
      ];
      break;
    case "EXECUTION_STARTED":
      targets = [scoped("EXECUTE_SLICE", currentFrontier(result), { owner: "serial-frontier" }), unscoped("REPLAN", "execution-history")];
      break;
    case "REQUIREMENTS_CHANGED": targets = [unscoped("REPLAN", "requirements-authority")]; break;
    case "DIVERGENCE_BLOCKED": {
      const lifecycle = (result.activeDivergences ?? []).filter((entry) => entry.requiredAuthorityOperation === "RESUME");
      // Documentary changes still belong to lifecycle. A concrete observation
      // can also be rechecked in its execution owner before any authority change.
      targets = lifecycle.map((entry) => scoped(null, entry.slice, {
        owner: "lifecycle", record: entry.record, authorityMode: "RESUME", invocation: "MODE=RESUME",
      }));
      for (const entry of result.activeDivergences ?? []) {
        const task = result.tasks.get(entry.slice);
        const operation = task.checklistComplete ? "VALIDATE_SLICE" : task.attempts.length ? "APPLY_FINDINGS" : "EXECUTE_SLICE";
        targets.push(scoped(operation, entry.slice, { owner: "blocker-revalidation", record: entry.record }));
      }
      if (lifecycle.length === 0 && hasGateReplanEvidence(result)) targets.push(unscoped("REPLAN", "active-divergence"));
      break;
    }
    case "AUXILIARY_BLOCKED": {
      const blocker = result.auxiliaryBlocked?.[0];
      if (blocker !== undefined) targets = [scoped(blocker.operation, blocker.slice, {
        owner: "auxiliary-check", record: blocker.record, round: blocker.round, sameOperationResumeRequired: true,
      })];
      break;
    }
    case "RUNNER_INITIALIZATION_BLOCKED":
    case "RUNNER_RESULT_BLOCKED": {
      const blocker = result.activeDelegationBlockers?.[0];
      if (blocker !== undefined) {
        const task = result.tasks.get(blocker.slice);
        const records = blocker.operation === "EXECUTE_SLICE" ? task.implementationChecks
          : blocker.operation === "APPLY_FINDINGS" ? task.findingsChecks : task.attempts;
        const prior = blocker.afterRecord === "none" ? null : records.find((record) => record.id === blocker.afterRecord);
        targets = [scoped(blocker.operation, blocker.slice, {
          owner: "delegation-blocker",
          record: prior?.id ?? null,
          round: blocker.pendingRound ?? prior?.round ?? null,
          sameOperationResumeRequired: true,
        })];
      }
      break;
    }
    case "IMPLEMENTATION_RETRY_EXHAUSTED":
    case "FINDINGS_RETRY_EXHAUSTED": {
      const kind = result.state === "FINDINGS_RETRY_EXHAUSTED" ? "FINDINGS" : "IMPLEMENTATION";
      const entry = result.exhausted?.find(([, value]) => value === kind);
      if (entry !== undefined) {
        const [slice] = entry;
        const task = result.tasks.get(slice);
        const record = kind === "FINDINGS" ? task.findingsChecks.at(-1) : task.implementationChecks.at(-1);
        targets = [scoped("VALIDATE_SLICE", slice, {
          owner: "retry-exhaustion", record: record?.id ?? null, round: record?.round ?? 3, retryState: result.state,
        })];
      }
      break;
    }
    case "IMPLEMENTED_AWAITING_VALIDATION":
      targets = [
        ...(result.implementedAwaitingValidation ?? []).map((slice) => {
          const record = result.tasks.get(slice).implementationChecks.at(-1);
          return scoped("VALIDATE_SLICE", slice, { owner: "implementation-check", record: record?.id ?? null, round: record?.round ?? null });
        }),
        unscoped("REPLAN", "execution-history"),
      ];
      break;
    case "FINDINGS_CORRECTED":
      targets = [
        ...(result.findingsCorrected ?? []).map((slice) => {
          const record = result.tasks.get(slice).findingsChecks.at(-1);
          return scoped("VALIDATE_SLICE", slice, { owner: "findings-check", record: record?.id ?? null, round: record?.round ?? null });
        }),
        unscoped("REPLAN", "execution-history"),
      ];
      break;
    case "VALIDATION_NEEDS_FIX":
      targets = (result.activeFindings ?? []).map((value) => {
        const [slice, record] = value.split(":");
        return scoped("APPLY_FINDINGS", slice, { owner: "active-finding", record });
      });
      for (const slice of new Set((result.activeFindings ?? []).map((value) => value.split(":")[0]))) {
        targets.push(scoped("VALIDATE_SLICE", slice, { owner: "blocker-revalidation" }));
      }
      break;
    case "VALIDATION_BLOCKED":
      targets = [
        ...(result.validationBlocked ?? []).map((slice) => scoped("VALIDATE_SLICE", slice, {
          owner: "validation-attempt", record: result.tasks.get(slice).attempts.at(-1)?.id ?? null,
        })),
        ...(hasGateReplanEvidence(result) ? [unscoped("REPLAN", "execution-history")] : []),
      ];
      break;
    case "REPLAN_REQUIRED": targets = [unscoped("REPLAN", "current-authority")]; break;
    case "COMPLETE": targets = [unscoped("CLOSE", "complete-execution"), unscoped("REPLAN", "complete-execution")]; break;
    default: targets = [];
  }
  for (const target of targets) {
    if (SLICE_OPERATIONS.has(target.operation) && target.slice === null) {
      throw new ExecutionContractError(`${result.state} lacks a concrete recovery slice for ${target.operation}`);
    }
  }
  return uniqueRecoveryTargets(targets);
}

function handoffForTarget(target) {
  const workflowSkill = workflowSkillForOperation(target.operation);
  return Object.freeze({
    workflowSkill,
    operation: target.operation,
    invocation: `OPERATION=${target.operation}`,
    slice: target.slice,
  });
}

export function workflowSkillForOperation(operation) {
  const workflowSkill = EXECUTION_WORKFLOW_SKILLS[String(operation)];
  if (workflowSkill === undefined) throw new ExecutionContractError(`no workflow skill owns ${operation}`);
  return workflowSkill;
}

function simplifiedTarget(target) {
  return Object.freeze({ operation: target.operation, slice: target.slice });
}

export function deriveLegalOperations(result, recoveryTargets = deriveRecoveryTargets(result)) {
  if (result.state === "EMPTY" && result.workspace.kind === "lifecycle" && result.lifecycleStatus !== "ready") {
    return Object.freeze([]);
  }
  if (recoveryTargets.some((target) => target.owner === "lifecycle")) {
    return Object.freeze(uniqueRecoveryTargets(recoveryTargets.filter((target) => target.owner === "blocker-revalidation").map(simplifiedTarget)));
  }
  const mandatory = recoveryTargets.filter((target) => target.sameOperationResumeRequired);
  if (mandatory.length > 1) throw new ExecutionContractError(`${result.state} has ambiguous mandatory recovery authority`);
  if (mandatory.length === 1) return Object.freeze([simplifiedTarget(mandatory[0])]);
  const legal = [];
  for (const [operation, states] of OPERATION_STATES) {
    if (!states.has(result.state)) continue;
    if (operation === "REPLAN" && ["VALIDATION_BLOCKED", "DIVERGENCE_BLOCKED"].includes(result.state) && !hasGateReplanEvidence(result)) continue;
    if (!SLICE_OPERATIONS.has(operation)) legal.push(Object.freeze({ operation, slice: null }));
    else {
      for (const target of recoveryTargets.filter((candidate) => candidate.operation === operation)) {
        legal.push(simplifiedTarget(target));
      }
    }
  }
  return Object.freeze(uniqueRecoveryTargets(legal));
}

function uniqueNormalTarget(result, operation) {
  const matches = result.legalOperations.filter((target) => target.operation === operation);
  return matches.length === 1 ? matches[0] : null;
}

export function deriveNormalHandoff(result, completedOperation = null) {
  if (result.mandatoryRecovery !== null) return null;
  let operation = null;
  if (completedOperation !== null) {
    workflowSkillForOperation(completedOperation);
    if (new Set(["PLAN", "REPLAN"]).has(completedOperation)
      && new Set(["PLANNED_DRAFT", "PENDING_REPLAN_DRAFT"]).has(result.state)) operation = "REVIEW_PLAN";
    else if (completedOperation === "REVIEW_PLAN"
      && new Set(["PLANNED_READY", "PENDING_REPLAN_READY"]).has(result.state)) operation = "MATERIALIZE_TASKS";
    else if (completedOperation === "MATERIALIZE_TASKS" && result.state === "MATERIALIZED_PRISTINE") operation = "REVIEW_TASKS";
    else if (completedOperation === "MATERIALIZE_TASKS" && result.state === "EXECUTION_STARTED") operation = "EXECUTE_SLICE";
    else if (completedOperation === "MATERIALIZE_TASKS"
      && new Set(["IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED"]).has(result.state)) operation = "VALIDATE_SLICE";
    else if (completedOperation === "REVIEW_TASKS" && result.state === "MATERIALIZED_PRISTINE") operation = "EXECUTE_SLICE";
    else if (completedOperation === "EXECUTE_SLICE" && result.state === "IMPLEMENTED_AWAITING_VALIDATION") operation = "VALIDATE_SLICE";
    else if (completedOperation === "APPLY_FINDINGS" && result.state === "FINDINGS_CORRECTED") operation = "VALIDATE_SLICE";
    else if (completedOperation === "VALIDATE_SLICE" && result.state === "VALIDATION_NEEDS_FIX") operation = "APPLY_FINDINGS";
    else if (completedOperation === "VALIDATE_SLICE" && result.state === "EXECUTION_STARTED") operation = "EXECUTE_SLICE";
    else if (completedOperation === "VALIDATE_SLICE" && result.state === "COMPLETE") operation = "CLOSE";
  } else if (result.state === "EMPTY") operation = "PLAN";
  else if (result.state === "PLANNED_DRAFT") operation = "REVIEW_PLAN";
  else if (result.state === "PLANNED_READY") operation = "MATERIALIZE_TASKS";
  else if (result.state === "EXECUTION_STARTED") operation = "EXECUTE_SLICE";
  else if (result.state === "IMPLEMENTED_AWAITING_VALIDATION" || result.state === "FINDINGS_CORRECTED") operation = "VALIDATE_SLICE";
  else if (result.state === "COMPLETE") operation = "CLOSE";
  if (operation === null) return null;
  const target = uniqueNormalTarget(result, operation);
  return target === null ? null : handoffForTarget(target);
}

function deriveRequiredRecoveryHandoff(result) {
  if (result.mandatoryRecovery !== null) return null;
  const lifecycle = result.recoveryTargets.filter((target) => target.owner === "lifecycle" && target.authorityMode === "RESUME");
  if (lifecycle.length !== 0) {
    const actionKeys = new Set(lifecycle.map((target) => [target.owner, target.authorityMode, target.invocation, target.slice].join("\0")));
    if (actionKeys.size !== 1) throw new ExecutionContractError(`${result.state} has ambiguous lifecycle recovery authority`);
    return Object.freeze({
      owner: "lifecycle",
      operation: null,
      invocation: "MODE=RESUME",
      slice: lifecycle[0].slice,
      record: lifecycle.length === 1 ? lifecycle[0].record : null,
    });
  }
  const targets = result.recoveryTargets.filter((target) => target.owner === "retry-exhaustion");
  if (targets.length > 1) throw new ExecutionContractError(`${result.state} has ambiguous required recovery authority`);
  return targets.length === 0 ? null : handoffForTarget(targets[0]);
}

function withRecoveryTargets(result) {
  const recoveryTargets = deriveRecoveryTargets(result);
  const mandatory = recoveryTargets.filter((target) => target.sameOperationResumeRequired);
  if (mandatory.length > 1) throw new ExecutionContractError(`${result.state} has ambiguous mandatory recovery authority`);
  const state = {
    ...result,
    recoveryTargets,
    legalOperations: deriveLegalOperations(result, recoveryTargets),
    mandatoryRecovery: mandatory.length === 1 ? mandatory[0] : null,
  };
  return {
    ...state,
    acceptedGates: [...result.tasks?.entries() ?? []].flatMap(([slice, task]) => {
      if (task.final.result === "SUPERSEDED") return [];
      const record = chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts).at(-1);
      return (record?.gates ?? []).filter((gate) => gate.decision === "bypassed").map((gate) => ({ slice, record: record.id, gate: gate.id, ...gate.bypass }));
    }),
    normalHandoff: deriveNormalHandoff(state),
    requiredRecoveryHandoff: deriveRequiredRecoveryHandoff(state),
  };
}

export function formatRecoveryTarget(target) {
  if (target.owner === "lifecycle" && target.authorityMode === "RESUME") return "lifecycle MODE=RESUME";
  return `${target.operation}${target.slice === null ? "" : ` for ${target.slice}`}`;
}

function recoverySuffix(targets) {
  if (targets.length === 0) return "";
  return `; legal next operation${targets.length === 1 ? " is" : "s are"} ${targets.map(formatRecoveryTarget).join(" or ")}`;
}

function recoveryError(operation, result) {
  return new ExecutionContractError(
    `${operation} is not legal from ${result.state}${recoverySuffix(result.recoveryTargets)}`,
    [],
    result.recoveryTargets,
  );
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function createCandidateShadow(workspace) {
  const liveProjectRoot = await trustedProjectRoot(workspace);
  const liveContainer = workspace.kind === "lifecycle" ? workspace.specRoot : path.dirname(workspace.authorityPath);
  if (!pathIsWithin(liveContainer, liveProjectRoot) || !pathIsWithin(workspace.executionRoot, liveProjectRoot)) {
    throw new ExecutionContractError("live execution workspace is outside its trusted project root");
  }
  const shadowParent = await fs.realpath(os.tmpdir());
  const shadowRoot = await fs.realpath(await fs.mkdtemp(path.join(
    shadowParent,
    `.${path.basename(liveContainer)}.stnl-execution-candidate-`,
  )));
  try {
    const shadowProjectRoot = path.join(shadowRoot, "project");
    await fs.mkdir(path.join(shadowProjectRoot, ".git"), { recursive: true });
    const shadowContainer = path.join(shadowProjectRoot, path.relative(liveProjectRoot, liveContainer));
    await fs.mkdir(shadowContainer, { recursive: true });
    if (workspace.kind === "standalone") {
      const authority = path.join(shadowContainer, path.basename(workspace.authorityPath));
      await fs.copyFile(workspace.authorityPath, authority);
      return {
        shadowRoot,
        specPath: authority,
        executionRoot: path.join(shadowProjectRoot, path.relative(liveProjectRoot, workspace.executionRoot)),
      };
    }
    const specRoot = shadowContainer;
    await fs.copyFile(workspace.authorityPath, path.join(specRoot, "feature_spec.md"));
    const shared = path.join(workspace.specRoot, "shared");
    const sharedMetadata = await lstatOrNull(shared);
    if (sharedMetadata !== null) await fs.cp(shared, path.join(specRoot, "shared"), { recursive: true });
    return { shadowRoot, specPath: specRoot, executionRoot: path.join(specRoot, "execution") };
  } catch (error) {
    await fs.rm(shadowRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertCandidateTreeSafe(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await fs.lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new ExecutionContractError(`candidate execution tree contains a symlink: ${entryPath}`, [entryPath]);
    if (metadata.isDirectory()) await assertCandidateTreeSafe(entryPath);
    else if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new ExecutionContractError(`candidate execution tree entry must be a single-link real file: ${entryPath}`, [entryPath]);
    }
  }
}

async function validateCurrentGateSnapshots(result, liveRecords = null) {
  const trustedRoot = await trustedProjectRoot(result.workspace);
  for (const [slice, task] of result.tasks ?? []) {
    const records = chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts);
    for (const record of records) {
      if (liveRecords !== null && liveRecords.get(`${slice}/${record.id}`) === record.body) continue;
      if (liveRecords === null && record !== records.at(-1)) continue;
      for (const gate of record.gates) for (const entry of gate.snapshot) {
        const target = path.resolve(result.workspace.executionRoot, "tasks", entry.path);
        await rejectSymlinkComponents(target, trustedRoot);
        const metadata = await lstatOrNull(target);
        const actual = metadata === null ? "REMOVED" : metadata.isFile() && !metadata.isSymbolicLink()
          ? `sha256:${createHash("sha256").update(await fs.readFile(target)).digest("hex")}` : "INVALID";
        if (actual !== entry.expected) throw new ExecutionContractError(`${slice}/${record.id}/${gate.id} observation is stale; revalidate current working tree`);
      }
    }
  }
}

async function validateCurrentEvidenceSubjects(result, liveRecords = null) {
  const trustedRoot = await trustedProjectRoot(result.workspace);
  const taskDirectory = path.join(result.workspace.executionRoot, "tasks");
  let currentSourceFingerprint = null;
  let currentHead = null;
  for (const [slice, task] of result.tasks ?? []) {
    const records = chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts);
    for (const record of records) {
      if (record.provenance === null || record.provenance.state !== "VERIFIED") continue;
      if (liveRecords !== null && liveRecords.has(`${slice}/${record.id}`)) continue;
      currentSourceFingerprint ??= await computeValidationSourceFingerprint(trustedRoot, result.workspace.executionRoot);
      if (record.provenance.inputs.sourceFingerprint !== currentSourceFingerprint) {
        throw new ExecutionContractError(`${slice}/${record.id} evidence source fingerprint is stale`);
      }
      currentHead ??= await readValidationHead(trustedRoot);
      if (record.provenance.inputs.head !== currentHead) {
        throw new ExecutionContractError(`${slice}/${record.id} evidence HEAD is stale`);
      }
      const physicalSubjects = new Set();
      for (const entry of record.provenance.subjects) {
        const target = path.resolve(taskDirectory, entry.path);
        await rejectSymlinkComponents(target, trustedRoot);
        const metadata = await lstatOrNull(target);
        let actual = "REMOVED";
        if (metadata !== null) {
          if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
            throw new ExecutionContractError(`${slice}/${record.id} evidence subject is not a single-link file: ${entry.path}`);
          }
          const physicalIdentity = `${metadata.dev}:${metadata.ino}`;
          if (physicalSubjects.has(physicalIdentity)) {
            throw new ExecutionContractError(`${slice}/${record.id} evidence subjects alias the same physical file: ${entry.path}`);
          }
          physicalSubjects.add(physicalIdentity);
          actual = `sha256:${createHash("sha256").update(await fs.readFile(target)).digest("hex")}`;
        }
        if (actual !== entry.expected) {
          throw new ExecutionContractError(`${slice}/${record.id} evidence is stale for ${entry.path}; expected ${entry.expected}, current ${actual}`);
        }
      }
    }
  }
}

// Compare the persisted record, not just its final semantic classification.
// Removing only these scalar disposition lines preserves every other original
// field (including unknown extensions and omitted legacy Kind) without a second
// list of identity fields that could drift from the schema.
function originalRecordBody(body, supersession) {
  const mutable = supersession ? /^- (?:State|Resolution|Superseded by):[^\n]*(?:\n|$)/gmu
    : /^- (?:State|Resolution):[^\n]*(?:\n|$)/gmu;
  return normalizeText(body.replace(mutable, ""));
}

function assertHistoricalRecord(original, candidate, label, { disposition = false, supersession = true } = {}) {
  if (candidate === undefined) throw new ExecutionContractError(`${label} historical record cannot be removed`);
  if (disposition && field(original.body, "State") === "active") {
    if (originalRecordBody(original.body, supersession) === originalRecordBody(candidate.body, supersession)) return;
  } else if (original.body === candidate.body) return;
  throw new ExecutionContractError(`${label} historical identity and authority are immutable`);
}

async function validateCandidateHistory(workspace, result) {
  const liveRecords = new Map();
  const newTerminalSlices = new Set();
  const liveSlices = new Set();
  const taskDirectory = path.join(workspace.executionRoot, "tasks");
  const entries = await fs.readdir(taskDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  // Enumerate live tasks so deleting a whole historical slice cannot evade the
  // comparison. Pristine replacement has no operational records to preserve.
  for (const entry of entries.filter((item) => !isIgnoredMetadata(item.name))) {
    const livePath = path.join(taskDirectory, entry.name);
    if (!SLICE_FILE.test(entry.name)) throw new ExecutionContractError(`non-canonical live task: ${livePath}`, [livePath]);
    await requireRealFile(livePath, "live historical task");
    const slice = entry.name.slice(0, -3);
    liveSlices.add(slice);
    const original = parseTask(await fs.readFile(livePath, "utf8"), livePath, slice);
    const candidate = result.tasks?.get(slice);
    if (candidate === undefined && original.pristine) continue;
    if (candidate === undefined) throw new ExecutionContractError(`${slice} historical task cannot be removed`);
    if (original.evidenceContract === "stnl-validation-evidence/v1"
      && candidate.evidenceContract !== original.evidenceContract) {
      throw new ExecutionContractError(`${slice} cannot remove or downgrade its validation evidence contract`);
    }
    if (original.final.result !== "pending" && original.body !== candidate.body) {
      throw new ExecutionContractError(`${slice} terminal task, validation base and supersession ownership are immutable`);
    }
    if (original.final.result === "pending" && SUCCESS_RESULTS.has(candidate.final.result)) {
      newTerminalSlices.add(slice);
    }
    if (!original.pristine && original.sections.get("References") !== candidate.sections.get("References")) {
      throw new ExecutionContractError(`${slice} historical task authority is immutable`);
    }
    for (const name of ["implementationChecks", "findingsChecks", "attempts", "findings", "divergences"]) {
      const disposition = name === "findings" || name === "divergences";
      const candidates = new Map(candidate[name].map((record) => [record.id, record]));
      for (const record of original[name]) {
        assertHistoricalRecord(record, candidates.get(record.id), `${slice}/${record.id}`, { disposition });
        if (!disposition) liveRecords.set(`${slice}/${record.id}`, record.body);
      }
      if (!disposition) {
        const historical = new Set(original[name].map((record) => record.id));
        for (const record of candidate[name].filter((candidateRecord) => !historical.has(candidateRecord.id))) {
          if (candidate.evidenceContract === "stnl-validation-evidence/v1" && record.provenance === null) {
            throw new ExecutionContractError(`${slice}/${record.id} newly persisted validation evidence requires structured provenance`);
          }
        }
      }
    }
    const historicalEvidence = new Map([
      ...original.implementationChecks, ...original.findingsChecks, ...original.attempts,
    ].filter((record) => record.provenance !== null)
      .map((record) => [record.provenance.evidenceId, record.provenance]));
    for (const record of [
      ...candidate.implementationChecks, ...candidate.findingsChecks, ...candidate.attempts,
    ]) {
      const replay = record.provenance?.replay;
      if (replay === null || replay === undefined) continue;
      const origin = historicalEvidence.get(replay.originalEvidenceId);
      if (origin === undefined || origin.state !== "VERIFIED"
        || origin.inputs.executionFingerprint !== replay.originalFingerprint) {
        throw new ExecutionContractError(`${slice}/${record.id} replay origin is not bound to persisted historical evidence`);
      }
    }
    const historicalFindings = new Set(original.findings.map((record) => record.id));
    for (const finding of candidate.findings.filter((record) => !historicalFindings.has(record.id))) {
      if (candidate.evidenceContract !== "stnl-validation-evidence/v1") continue;
      const kind = field(finding.body, "Kind");
      const evidenceIdentity = field(finding.body, "Evidence identity");
      if (!new Set(["implementation_defect", "code_regression"]).has(kind)) {
        throw new ExecutionContractError(`${slice}/${finding.id} has invalid finding Kind`);
      }
      const origin = candidate.attempts.find((attempt) => attempt.id === finding.origin);
      if (origin?.provenance === null || origin?.provenance?.state !== "VERIFIED"
        || evidenceIdentity !== origin.provenance.evidenceId) {
        throw new ExecutionContractError(`${slice}/${finding.id} is not bound to verified origin evidence`);
      }
      const expectedConclusion = kind === "code_regression" ? "CODE_REGRESSION" : "VALIDATION_FINDING";
      if (origin.provenance.conclusion !== expectedConclusion) {
        throw new ExecutionContractError(`${slice}/${finding.id} classification disagrees with its verified evidence`);
      }
    }
    for (const divergence of candidate.divergences) {
      if (divergence.revalidationRecord !== undefined
        && original.divergences.some((record) => record.id === divergence.id && record.state === "active")
        && liveRecords.has(`${slice}/${divergence.revalidationRecord}`)) {
        throw new ExecutionContractError(`${slice}/${divergence.id} resolution requires a newly appended revalidation record`);
      }
    }
    if (original.delegationBlocker !== null) {
      assertHistoricalRecord(
        { body: original.sections.get("Delegation Blocker") },
        candidate.delegationBlocker === null ? undefined : { body: candidate.sections.get("Delegation Blocker") },
        `${slice}/Delegation Blocker`, { disposition: true, supersession: false },
      );
    } else if (candidate.delegationBlocker !== null
      && candidate.delegationBlocker.operation !== "VALIDATE_SLICE"
      && field(candidate.sections.get("Delegation Blocker"), "Pending automatic round", { required: false }) === null) {
      throw new ExecutionContractError(`${slice}/Delegation Blocker newly persisted auxiliary recovery requires Pending automatic round`);
    }
  }
  for (const [slice, candidate] of result.tasks ?? []) {
    if (!liveSlices.has(slice) && candidate.evidenceContract !== "stnl-validation-evidence/v1") {
      throw new ExecutionContractError(`${slice} newly materialized task requires validation evidence contract stnl-validation-evidence/v1`);
    }
    if (!liveSlices.has(slice) && !candidate.pristine) {
      throw new ExecutionContractError(`${slice} newly materialized task must be pristine before execution evidence can exist`);
    }
  }
  return { liveRecords, newTerminalSlices };
}

export async function validateExecutionCandidate(specPath, candidateExecutionRoot) {
  const workspace = await resolveExecutionWorkspace(specPath);
  let candidate = path.resolve(String(candidateExecutionRoot));
  await assertNoSymlinkComponents(candidate, "candidate execution root");
  const metadata = await lstatOrNull(candidate);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ExecutionContractError(`candidate execution root must be a real directory: ${candidate}`, [candidate]);
  }
  candidate = await fs.realpath(candidate);
  const liveExecutionRoot = await fs.realpath(workspace.executionRoot);
  if (pathIsWithin(candidate, liveExecutionRoot) || pathIsWithin(liveExecutionRoot, candidate)) {
    throw new ExecutionContractError("candidate execution root must be isolated from live execution artifacts", [candidate]);
  }
  await assertCandidateTreeSafe(candidate);
  const shadow = await createCandidateShadow(workspace);
  try {
    await fs.cp(candidate, shadow.executionRoot, { recursive: true });
    const result = await inspectExecutionState(shadow.specPath);
    if ((result.incompleteExecutionChecklists?.length ?? 0) !== 0) {
      const inconsistency = result.incompleteExecutionChecklists[0];
      throw new ExecutionContractError(
        `candidate cannot finalize execution for ${inconsistency.slice} while its mandatory checklist is incomplete`,
        [],
        result.recoveryTargets,
      );
    }
    const { liveRecords, newTerminalSlices } = await validateCandidateHistory(workspace, result);
    await validateCurrentGateSnapshots({ ...result, workspace }, liveRecords);
    await validateCurrentEvidenceSubjects({ ...result, workspace }, liveRecords);
    if (result.rows !== undefined) {
      validateTerminalOverlapDeclarations(result, { onlySlices: newTerminalSlices });
      await validateFinalOwnership({ ...result, workspace }, { onlySlices: newTerminalSlices });
    }
    return Object.freeze({
      state: result.state,
      currentFingerprint: result.currentFingerprint,
      legalOperations: result.legalOperations,
      mandatoryRecovery: result.mandatoryRecovery,
      normalHandoff: result.normalHandoff,
      requiredRecoveryHandoff: result.requiredRecoveryHandoff,
    });
  } finally {
    await fs.rm(shadow.shadowRoot, { recursive: true, force: true });
  }
}

async function lstatRepairPath(filePath) {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function sameRepairIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

async function captureRepairFile(filePath, label) {
  const before = await lstatRepairPath(filePath);
  if (before === null || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new ExecutionContractError(`${label} must remain a single-link real file: ${filePath}`, [filePath]);
  }
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!sameRepairIdentity(before, openedBefore) || !openedBefore.isFile() || openedBefore.nlink !== 1n) {
      throw new ExecutionContractError(`${label} identity changed while opening: ${filePath}`, [filePath]);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstatRepairPath(filePath);
    if (!sameRepairIdentity(openedBefore, openedAfter) || !sameRepairIdentity(openedAfter, after)
      || openedBefore.size !== openedAfter.size || openedBefore.mtimeNs !== openedAfter.mtimeNs
      || openedBefore.ctimeNs !== openedAfter.ctimeNs || openedAfter.nlink !== 1n) {
      throw new ExecutionContractError(`${label} changed while being read: ${filePath}`, [filePath]);
    }
    return Object.freeze({ filePath, bytes, metadata: openedAfter });
  } finally {
    await handle.close();
  }
}

function repairSnapshotsMatch(left, right) {
  return sameRepairIdentity(left.metadata, right.metadata) && left.bytes.equals(right.bytes);
}

async function createRepairOwnedFile(filePath, bytes, mode, label) {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new ExecutionContractError(`${label} is not a single-link real file: ${filePath}`, [filePath]);
    }
    await handle.close();
    handle = null;
    const snapshot = await captureRepairFile(filePath, label);
    if (!sameRepairIdentity(snapshot.metadata, metadata) || !snapshot.bytes.equals(bytes)) {
      throw new ExecutionContractError(`${label} ownership changed during creation; foreign path preserved: ${filePath}`, [filePath]);
    }
    return snapshot;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function removeRepairOwnedPath(snapshot, label) {
  const current = await lstatRepairPath(snapshot.filePath);
  if (current === null) return;
  if (!sameRepairIdentity(current, snapshot.metadata)) {
    throw new ExecutionContractError(`${label} ownership changed; foreign path preserved: ${snapshot.filePath}`, [snapshot.filePath]);
  }
  await fs.unlink(snapshot.filePath);
}

async function linkRepairOwnedFile(source, target, label) {
  try {
    await fs.link(source.filePath, target);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  const installed = await lstatRepairPath(target);
  if (!sameRepairIdentity(installed, source.metadata)) {
    throw new ExecutionContractError(`${label} identity changed during no-replace publication: ${target}`, [target]);
  }
  return true;
}

function repairLockPath(workspace) {
  return `${workspace.executionRoot}.stnl-contract-repair.lock`;
}

async function acquireContractRepairLock(workspace) {
  const filePath = repairLockPath(workspace);
  const owner = randomUUID();
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, owner, pid: process.pid })}\n`, "utf8");
  let snapshot;
  try {
    snapshot = await createRepairOwnedFile(filePath, bytes, 0o600, "contract repair lock");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ExecutionContractError(`another contract repair owns the lock: ${filePath}`, [filePath]);
    }
    throw error;
  }
  return Object.freeze({ ...snapshot, owner });
}

async function releaseContractRepairLock(lock) {
  const current = await captureRepairFile(lock.filePath, "contract repair lock");
  if (!repairSnapshotsMatch(lock, current)) {
    throw new ExecutionContractError(`contract repair lock ownership changed; foreign lock preserved: ${lock.filePath}`, [lock.filePath]);
  }
  const retiredPath = `${lock.filePath}.retired-${lock.owner}`;
  await fs.rename(lock.filePath, retiredPath);
  const retired = await captureRepairFile(retiredPath, "retired contract repair lock");
  if (!sameRepairIdentity(retired.metadata, lock.metadata) || !retired.bytes.equals(lock.bytes)) {
    if (await lstatRepairPath(lock.filePath) === null) await fs.link(retiredPath, lock.filePath);
    throw new ExecutionContractError(`contract repair lock changed during release; foreign lock preserved: ${retiredPath}`, [retiredPath]);
  }
  await removeRepairOwnedPath(retired, "retired contract repair lock");
}

async function assertContractRepairLock(lock) {
  const current = await captureRepairFile(lock.filePath, "contract repair lock");
  if (!repairSnapshotsMatch(lock, current)) {
    throw new ExecutionContractError(`contract repair lock ownership changed; foreign lock preserved: ${lock.filePath}`, [lock.filePath]);
  }
}

async function withContractRepairLock(workspace, action) {
  const lock = await acquireContractRepairLock(workspace);
  let result;
  let actionError = null;
  try {
    result = await action(lock);
  } catch (error) {
    actionError = error;
  }
  let releaseError = null;
  try {
    await releaseContractRepairLock(lock);
  } catch (error) {
    releaseError = error;
  }
  if (actionError !== null && releaseError !== null) {
    const combined = new ExecutionContractError(
      `contract repair failed: ${actionError.message}; lock release also failed: ${releaseError.message}`,
      [...new Set([...(actionError.findings ?? []), ...(releaseError.findings ?? [])])],
    );
    combined.cause = new AggregateError([actionError, releaseError], "repair action and lock release both failed");
    throw combined;
  }
  if (actionError !== null) throw actionError;
  if (releaseError !== null) throw releaseError;
  return result;
}

async function restoreClaimedRepairSource(backup, artifact) {
  const live = await lstatRepairPath(artifact);
  if (live === null) {
    const restored = await linkRepairOwnedFile(backup, artifact, "contract repair rollback");
    if (!restored) return false;
  }
  await removeRepairOwnedPath(backup, "contract repair source backup");
  return live === null;
}

async function rollbackRepairPublication({ artifact, published, backup }) {
  let live;
  try {
    live = await captureRepairFile(artifact, "published contract repair candidate");
  } catch {
    live = null;
  }
  if (live === null || !repairSnapshotsMatch(live, published)) {
    await removeRepairOwnedPath(backup, "contract repair source backup");
    return false;
  }
  const retiredPath = `${artifact}.stnl-contract-repair-rollback-${process.pid}-${randomUUID()}`;
  await fs.rename(artifact, retiredPath);
  const retired = await captureRepairFile(retiredPath, "retired contract repair candidate");
  if (!repairSnapshotsMatch(retired, published)) {
    if (await lstatRepairPath(artifact) === null) await fs.link(retiredPath, artifact);
    throw new ExecutionContractError(`published repair ownership changed during rollback; foreign bytes preserved: ${retiredPath}`, [retiredPath]);
  }
  const restored = await linkRepairOwnedFile(backup, artifact, "contract repair rollback");
  if (restored) await removeRepairOwnedPath(backup, "contract repair source backup");
  await removeRepairOwnedPath(retired, "retired contract repair candidate");
  return restored;
}

function repairBlockedError(violation) {
  const found = violation.foundField === null ? "missing field" : `'${violation.foundField}'`;
  const expected = violation.expectedField ?? "known canonical field";
  return new ExecutionContractError(
    `${violation.artifact}:${violation.record} expected ${expected}; found ${found}; contract repair blocked (${violation.reason})`,
    [violation.artifact],
    [],
    violation,
  );
}

function applyMechanicalRepair(text, violation) {
  const escapedRecord = violation.record.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headings = [...text.matchAll(new RegExp(`^### ${escapedRecord}$`, "gmu"))];
  if (headings.length !== 1) {
    throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "record-identity-changed" }));
  }
  const recordStart = headings[0].index;
  const boundary = /^#{2,3} /gmu;
  boundary.lastIndex = recordStart + headings[0][0].length;
  const nextHeading = boundary.exec(text);
  const recordEnd = nextHeading?.index ?? text.length;
  const record = text.slice(recordStart, recordEnd);
  let repairedRecord = record;
  let changedLabel;
  if (violation.kind === "non-canonical-field") {
    if (exactFieldLines(record, "Findings IDs").length !== 1 || exactFieldLines(record, "Finding IDs").length !== 0) {
      throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "record-fields-changed" }));
    }
    repairedRecord = record.replace(/^- Findings IDs:(?=[ \t])/mu, "- Finding IDs:");
    changedLabel = "Findings IDs -> Finding IDs";
  } else if (violation.kind === "legacy-discovery-labels") {
    const exactLegacyPair = exactFieldLines(record, "Check discovery sources").length === 1
      && exactFieldLines(record, "Check discovery actions").length === 1;
    const canonicalAbsent = exactFieldLines(record, "Discovery sources").length === 0
      && exactFieldLines(record, "Discovery actions").length === 0;
    if (!exactLegacyPair || !canonicalAbsent) {
      throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "record-fields-changed" }));
    }
    repairedRecord = record
      .replace(/^- Check discovery sources:(?=[ \t])/mu, "- Discovery sources:")
      .replace(/^- Check discovery actions:(?=[ \t])/mu, "- Discovery actions:");
    changedLabel = "Check discovery sources/actions -> Discovery sources/actions";
  } else {
    throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "unsupported-repair-kind" }));
  }
  if (repairedRecord === record) {
    throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "non-lossless-label-replacement" }));
  }
  return Object.freeze({
    text: `${text.slice(0, recordStart)}${repairedRecord}${text.slice(recordEnd)}`,
    repair: Object.freeze({ ...violation, changedLabel }),
  });
}

export async function repairExecutionContract(specPath) {
  let initialViolation;
  try {
    const state = await inspectExecutionState(specPath);
    return Object.freeze({ status: "UNCHANGED", repairs: Object.freeze([]), state: state.state });
  } catch (error) {
    if (!(error instanceof ExecutionContractError)) throw error;
    if (error.contractViolation?.repairability !== "mechanical") throw error;
    initialViolation = error.contractViolation;
  }

  const workspace = await resolveExecutionWorkspace(specPath);
  const artifact = path.resolve(String(initialViolation.artifact));
  const taskRoot = path.join(workspace.executionRoot, "tasks");
  if (!pathIsWithin(artifact, taskRoot) || path.dirname(artifact) !== taskRoot || !SLICE_FILE.test(path.basename(artifact))) {
    throw repairBlockedError(Object.freeze({ ...initialViolation, repairability: "blocked", reason: "artifact-outside-task-root" }));
  }
  const initialSource = await captureRepairFile(artifact, "contract repair artifact");
  const original = initialSource.bytes;
  const relativeArtifact = path.relative(workspace.executionRoot, artifact);
  const shadow = await createCandidateShadow(workspace);
  try {
    await fs.cp(workspace.executionRoot, shadow.executionRoot, { recursive: true });
    await assertCandidateTreeSafe(shadow.executionRoot);
    const repairs = [];
    let candidateState;
    while (true) {
      try {
        candidateState = await inspectExecutionState(shadow.specPath);
        break;
      } catch (error) {
        if (!(error instanceof ExecutionContractError) || error.contractViolation?.repairability !== "mechanical") throw error;
        const violation = error.contractViolation;
        const shadowArtifact = path.resolve(String(violation.artifact));
        const shadowTaskRoot = path.join(shadow.executionRoot, "tasks");
        const shadowRelative = path.relative(shadow.executionRoot, shadowArtifact);
        if (!pathIsWithin(shadowArtifact, shadowTaskRoot) || path.dirname(shadowArtifact) !== shadowTaskRoot || !SLICE_FILE.test(path.basename(shadowArtifact))) {
          throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "artifact-outside-task-root" }));
        }
        if (shadowRelative !== relativeArtifact) {
          throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "multi-artifact-repair-is-not-atomic" }));
        }
        const before = await fs.readFile(shadowArtifact, "utf8");
        const applied = applyMechanicalRepair(before, violation);
        await fs.writeFile(shadowArtifact, applied.text, "utf8");
        repairs.push(applied.repair);
        if (repairs.length > 100) {
          throw repairBlockedError(Object.freeze({ ...violation, repairability: "blocked", reason: "repair-count-exceeds-bounded-limit" }));
        }
      }
    }
    const candidateBytes = await fs.readFile(path.join(shadow.executionRoot, relativeArtifact));
    return await withContractRepairLock(workspace, async (lock) => {
      const currentSource = await captureRepairFile(artifact, "contract repair source");
      if (!repairSnapshotsMatch(currentSource, initialSource)) {
        throw new ExecutionContractError(`contract repair source changed during candidate validation: ${artifact}`, [artifact]);
      }

      const stagePath = `${artifact}.stnl-contract-repair-stage-${process.pid}-${randomUUID()}`;
      const backupPath = path.join(
        path.dirname(workspace.executionRoot),
        `.${path.basename(workspace.executionRoot)}.stnl-contract-repair-backup-${process.pid}-${randomUUID()}`,
      );
      let stage = null;
      let backup = null;
      let published = null;
      try {
        stage = await createRepairOwnedFile(stagePath, candidateBytes, Number(currentSource.metadata.mode), "contract repair candidate stage");
        await assertContractRepairLock(lock);
        await fs.rename(artifact, backupPath);
        backup = await captureRepairFile(backupPath, "contract repair source backup");
        if (!sameRepairIdentity(backup.metadata, initialSource.metadata) || !backup.bytes.equals(original)) {
          await restoreClaimedRepairSource(backup, artifact);
          backup = null;
          throw new ExecutionContractError(`contract repair concurrent source changed before publication; publication aborted: ${artifact}`, [artifact]);
        }

        if (!await linkRepairOwnedFile(stage, artifact, "contract repair candidate publication")) {
          await restoreClaimedRepairSource(backup, artifact);
          backup = null;
          throw new ExecutionContractError(`contract repair concurrent source occupied the publication path; publication aborted: ${artifact}`, [artifact]);
        }
        const stageMetadata = stage.metadata;
        await removeRepairOwnedPath(stage, "contract repair candidate stage");
        stage = null;
        published = await captureRepairFile(artifact, "published contract repair candidate");
        if (!sameRepairIdentity(published.metadata, stageMetadata)
          || !published.bytes.equals(candidateBytes)) {
          throw new ExecutionContractError(`contract repair candidate changed during publication: ${artifact}`, [artifact]);
        }

        const state = await inspectExecutionState(specPath);
        const readback = await captureRepairFile(artifact, "strict contract repair readback");
        if (!repairSnapshotsMatch(readback, published) || !readback.bytes.equals(candidateBytes)) {
          throw new ExecutionContractError(`contract repair strict readback lost publication ownership: ${artifact}`, [artifact]);
        }
        const retainedSource = await captureRepairFile(backupPath, "contract repair source backup");
        if (!sameRepairIdentity(retainedSource.metadata, backup.metadata) || !retainedSource.bytes.equals(original)) {
          backup = retainedSource;
          throw new ExecutionContractError(`contract repair source changed through an open writer during readback: ${artifact}`, [artifact]);
        }
        await removeRepairOwnedPath(backup, "contract repair source backup");
        backup = null;
        return Object.freeze({
          status: "REPAIRED",
          repairs: Object.freeze(repairs),
          state: state.state ?? candidateState.state,
        });
      } catch (error) {
        if (published !== null && backup !== null) {
          await rollbackRepairPublication({ artifact, published, backup });
          backup = null;
        } else if (backup !== null) {
          await restoreClaimedRepairSource(backup, artifact);
          backup = null;
        }
        if (stage !== null) await removeRepairOwnedPath(stage, "contract repair candidate stage");
        throw error;
      }
    });
  } finally {
    await fs.rm(shadow.shadowRoot, { recursive: true, force: true });
  }
}

export async function preflightExecutionOperation(specPath, operation, sliceValue = null) {
  const normalizedOperation = String(operation);
  const result = await inspectExecutionState(specPath);
  if (!OPERATIONS.has(normalizedOperation)) {
    throw new ExecutionContractError(
      `unsupported operation ${normalizedOperation}${recoverySuffix(result.recoveryTargets)}`,
      [],
      result.recoveryTargets,
    );
  }
  if (normalizedOperation === "PLAN" && result.state === "EMPTY"
    && result.workspace.kind === "lifecycle" && result.lifecycleStatus !== "ready") {
    throw new ExecutionContractError(
      `lifecycle status ${result.lifecycleStatus} cannot authorize PLAN; lifecycle PLAN requires ready`,
      [],
      result.recoveryTargets,
    );
  }
  if (normalizedOperation === "REPLAN" && ["VALIDATION_BLOCKED", "DIVERGENCE_BLOCKED"].includes(result.state)
    && !hasGateReplanEvidence(result) && !result.recoveryTargets.some((target) => target.owner === "lifecycle")) {
    throw new ExecutionContractError("REPLAN requires current slice relevance, causal evidence and proof that no in-scope correction is valid; revalidate the blocker first", [], result.recoveryTargets);
  }
  const needsSlice = SLICE_OPERATIONS.has(normalizedOperation);
  const hasSlice = sliceValue !== null && sliceValue !== undefined;
  let slice = null;
  let invalidSlice = false;
  if (hasSlice) {
    const raw = String(sliceValue);
    invalidSlice = !/^(?:0|[1-9][0-9]*)$/u.test(raw);
    if (!invalidSlice) slice = `slice-${raw.padStart(2, "0")}`;
  }
  const mandatoryRecovery = result.recoveryTargets.find((target) => target.sameOperationResumeRequired);
  if (mandatoryRecovery !== undefined
    && (mandatoryRecovery.operation !== normalizedOperation || mandatoryRecovery.slice !== slice)) {
    throw recoveryError(normalizedOperation, result);
  }
  if (needsSlice !== hasSlice) {
    throw new ExecutionContractError(
      `${normalizedOperation} ${needsSlice ? "requires" : "does not accept"} SLICE${recoverySuffix(result.recoveryTargets)}`,
      [],
      result.recoveryTargets,
    );
  }
  if (invalidSlice) {
    throw new ExecutionContractError(
      `SLICE must be one unsigned decimal number without prefix${recoverySuffix(result.recoveryTargets)}`,
      [],
      result.recoveryTargets,
    );
  }
  const allowed = OPERATION_STATES.get(normalizedOperation);
  const exactMandatoryRecovery = mandatoryRecovery !== undefined
    && mandatoryRecovery.operation === normalizedOperation && mandatoryRecovery.slice === slice;
  if (!allowed.has(result.state) && !exactMandatoryRecovery) throw recoveryError(normalizedOperation, result);
  if (!result.legalOperations.some((target) => target.operation === normalizedOperation && target.slice === slice)) {
    throw recoveryError(normalizedOperation, result);
  }
  const operationTargets = result.recoveryTargets.filter((target) => target.operation === normalizedOperation);
  if (operationTargets.length !== 0 && !operationTargets.some((target) => target.slice === slice)) {
    throw recoveryError(normalizedOperation, result);
  }
  if (slice !== null && !result.tasks?.has(slice)) throw new ExecutionContractError(`${slice} is absent from the execution artifacts`);
  if (slice !== null) {
    const selectedRow = result.rows.find((row) => row.slice === slice);
    const selectedTask = result.tasks.get(slice);
    if (selectedRow.done || selectedTask.final.result !== "pending") throw new ExecutionContractError(`${slice} is terminal and immutable`);
    const selectedIndex = result.rows.indexOf(selectedRow);
    if (result.rows.slice(0, selectedIndex).some((row) => !row.done)) throw new ExecutionContractError(`${slice} has an incomplete serial dependency`);
    if (normalizedOperation === "EXECUTE_SLICE") {
      const resumesPersistedDelegation = exactMandatoryRecovery && mandatoryRecovery.owner === "delegation-blocker";
      if (selectedTask.attempts.length !== 0 && !resumesPersistedDelegation) {
        throw new ExecutionContractError(`${slice} already has formal validation history; EXECUTE_SLICE cannot re-enter`);
      }
    }
    if (normalizedOperation === "VALIDATE_SLICE" && !selectedTask.checklistComplete) throw new ExecutionContractError(`${slice} checklist is incomplete`);
  }
  if (normalizedOperation === "APPLY_FINDINGS" && !result.tasks.get(slice).findings.some((record) => record.severity === "blocking" && record.state === "active")) {
    throw new ExecutionContractError(`${slice} has no active blocking finding`);
  }
  if (normalizedOperation === "REPLAN" && ["VALIDATION_BLOCKED", "DIVERGENCE_BLOCKED"].includes(result.state)) {
    const tasks = [...result.tasks.values()].filter((task) => task.final.result === "pending");
    if (!tasks.some((task) => chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts).at(-1)?.gates.some((gate) => gate.decision === "replan"))) {
      throw new ExecutionContractError("REPLAN requires current slice relevance, causal evidence and proof that no in-scope correction is valid; revalidate the blocker first", [], result.recoveryTargets);
    }
    await validateCurrentGateSnapshots(result);
  }
  if (normalizedOperation === "CLOSE") {
    validateTerminalOverlapDeclarations(result);
    await validateFinalOwnership(result);
  }
  const revalidation = slice === null ? [] : blockerRevalidation(result.tasks.get(slice));
  return { ...result, operation: normalizedOperation, slice, revalidation };
}

function blockerRevalidation(task) {
  const records = chronologicalQualityRecords(task.implementationChecks, task.findingsChecks, task.attempts);
  return [
    ...task.activeBlockers.map((record) => ({ record: record.id, reason: "reobserve current condition before correction or authority change" })),
    ...(task.delegationBlocker?.state === "active" ? [{ record: "Delegation Blocker", reason: "retry the logical runner invocation" }] : []),
    ...records.slice(-1).filter((record) => record.status === "BLOCKED" || record.gates.some((gate) => gate.decision === "bypassed"))
      .map((record) => ({ record: record.id, reason: "rerun applicable checks against the working tree; old verdict and HEAD are not current truth" })),
  ];
}
