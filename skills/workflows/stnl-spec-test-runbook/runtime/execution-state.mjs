#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import { projectPreparationAuthority, readPreparationArtifacts, parsePreparationArtifact, preparationChecklist,
  preparationPathClaims, parseVerificationRecipe, verificationReferences, validateApprovedPreparation, validateOperationalChanges, parseStrictJson } from './execution-preparation.mjs';
import { readActivatedExecution, beginExecutionOperation, withExecutionPublicationLock,
  publishExecutionUpdate, captureExecutionTree, readOwnedFile, assertExecutionAttempt, readRetainedAllocation,
  retentionSha256, persistAllocation, executionLockIdentity, preparationRegistryPath, classifyOwnedAllocation, hasOwnedAllocationEnvelope } from './execution-publication.mjs';
import path from "node:path";

const ROOT_FILES = new Set(["plan.md", "tasks.md", "approved-preparation.json", "activation.json", "continuity.json"]);
const ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SLICE_FILE = /^slice-[0-9]{2,}\.md$/u;
const SLICE_OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const OPERATIONS = new Set([
  "PLAN", "REVIEW_PLAN", "REPLAN",
  "EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE",
]);
export const EXECUTION_WORKFLOW_SKILLS = Object.freeze({
  PLAN: "stnl-execution-planner",
  REPLAN: "stnl-execution-planner",
  REVIEW_PLAN: "stnl-plan-reviewer",
  EXECUTE_SLICE: "stnl-slice-executor",
  APPLY_FINDINGS: "stnl-slice-executor",
  VALIDATE_SLICE: "stnl-slice-quality-manager",
});
const OPERATION_STATES = new Map([
  ["PLAN", new Set(["EMPTY"])],
  ["REVIEW_PLAN", new Set(["PLANNED_DRAFT", "PLANNED_READY", "PENDING_REPLAN_DRAFT", "PENDING_REPLAN_READY"])],
  ["REPLAN", new Set(["PLANNED_DRAFT", "PLANNED_READY", "MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "REQUIREMENTS_CHANGED", "DIVERGENCE_BLOCKED", "VALIDATION_BLOCKED", "IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "REPLAN_REQUIRED", "COMPLETE"])],
  ["EXECUTE_SLICE", new Set(["MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
  ["APPLY_FINDINGS", new Set(["VALIDATION_NEEDS_FIX", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
  ["VALIDATE_SLICE", new Set(["IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "VALIDATION_BLOCKED", "IMPLEMENTATION_RETRY_EXHAUSTED", "FINDINGS_RETRY_EXHAUSTED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"])],
]);
const CURRENT_AUTHORITY = /^sha256:([0-9a-f]{64})$/u;
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
const GLOBAL_PLAN_SECTIONS = ["Global Context", "Serial Slice Order", "Delivery Continuity", "Global Risks and Integration"];
const SLICE_PLAN_SECTIONS = [
  "References", "Objective and Observable Result", "Requirements", "Included Scope", "Out of Scope and Boundaries",
  "Authorized Areas", "Expected Files", "Existing Inputs", "Protected Responsibilities", "Dependencies", "Risks and Strategy", "Expected Tests", "Verification Recipe", "Completion Criterion",
];
const TASK_SECTIONS = [
  "References", "Result", "Acceptance Obligations", "Authorized Areas", "Expected Files", "Existing Inputs", "Protected Responsibilities", "Checklist", "Expected Tests", "Verification Recipe", "Continuity", "Operational Changes", "Changed Areas", "Scope Expansion", "Prior Validation Overlap",
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
  let selected = (await fs.lstat(physical)).isDirectory() ? physical : path.dirname(physical);
  // Allocation ownership applies to every descendant. Visit only the selected
  // physical ancestry, including its filesystem root, without a depth cutoff.
  while (true) {
    const markers=[`${selected}.copy.json`,`${selected}.publication.json`,`${selected}.owner.json`];
    const generated=/^\.stnl-execution-(?:stage|backup)-([a-f0-9-]{36})$/u.exec(path.basename(selected));
    if (generated) markers.push(path.join(path.dirname(selected),`.stnl-execution-publication-${generated[1]}.json`));
    for (const marker of markers) if (await lstatOrNull(marker)) {
      let record;try {record=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));}catch {continue;}
      if(!hasOwnedAllocationEnvelope(record,marker)) continue;
      // Nearby markers are untrusted hints. A failed producer/retention binding
      // grants no ownership; registered control references remain strict below.
      try {
        const official = record.format==='stnl-preparation-allocation-v1'
          ? await resolvePhysicalExecutionWorkspace(await fs.realpath(record.specPath)) : {executionRoot:record.executionRoot};
        await classifyOwnedAllocation({workspace:official,marker});
      }catch {continue;}
      const roots=[record.candidate,record.stage,record.backup,record.retentionRoot].filter(Boolean);
      if (record.executionRoot && roots.some(root=>pathIsWithin(physical,root)) && !pathIsWithin(physical,record.executionRoot)) {
        throw new ExecutionContractError('owned operational candidate/stage/backup cannot be selected as official SPEC_PATH',[physical]);
      }
    }
    const parent=path.dirname(selected);
    if(parent===selected) break;
    selected=parent;
  }
  return resolvePhysicalExecutionWorkspace(physical);
}

// Private kernel shadows are validated against a separately resolved logical SPEC.
// The public resolver still refuses every positively owned operational allocation.
async function resolvePhysicalExecutionWorkspace(physical) {
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
  return findNonCanonicalPathsForWorkspace(await resolveExecutionWorkspace(specPath),{allowAbsent,allowPlanned});
}
async function findNonCanonicalPathsForWorkspace({specRoot,executionRoot},{allowAbsent=false,allowPlanned=false}={}) {
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
    const pendingReplan = /^- Revision mode: (?:pristine-replacement|append-only-extension|same-delivery-revision)$/gmu.test(planText);
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
    const missing = expected.filter((name) => !parsed.has(name));
    const unexpected = actual.filter((name) => !expected.includes(name));
    throw new ExecutionContractError(
      `${label} has non-canonical sections; missing=${JSON.stringify(missing)}; unexpected=${JSON.stringify(unexpected)}; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`,
    );
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
        const sharedText = await fs.readFile(path.join(shared, entry.name), "utf8");
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
  return requirementsAuthorityForWorkspace(workspace);
}

async function requirementsAuthorityForWorkspace(workspace) {
  const payload = workspace.kind === "standalone"
    ? await fs.readFile(workspace.authorityPath)
    : stableEncode(await lifecycleProjection(workspace));
  return createHash("sha256").update(HASH_DOMAIN).update(payload).digest("hex");
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
        "| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |",
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
  parsePreparationArtifact(text, expectedSlice === null ? "plan.md" : `plans/${expectedSlice}.md`);
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
  if (revisionMode !== null && !new Set(["pristine-replacement", "append-only-extension", "same-delivery-revision"]).has(revisionMode)) {
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

export function approvedDetailedPlanIncludedScope(text, slice) {
  if (typeof slice !== "string" || !/^slice-[0-9]{2,}$/u.test(slice)) {
    throw new ExecutionContractError("approved detailed plan requires a canonical slice identity");
  }
  const plan = parsePlan(text, `plans/${slice}.md`, slice);
  if (plan.status !== "ready" || plan.reviewState !== "approved") {
    throw new ExecutionContractError("directory expected area requires an approved detailed plan");
  }
  return plan.sections.get("Included Scope");
}

function hasUnencodedTemplatePlaceholder(value) {
  const withoutEncodedValues = String(value).replace(/json:"(?:\\.|[^"\\])*"/gu, 'json:""');
  return withoutEncodedValues.split("\n").some((line) => {
    const command = line.match(/^  - `([^`\r\n]+)` \| exit:-?[0-9]+$/u)?.[1];
    if (command === undefined) return /<[^>\n]+>/u.test(line);
    return [...command.matchAll(/<[^>\n]+>/gu)].some((match) => {
      const between = match[0].slice(1, -1);
      const after = command.slice(match.index + match[0].length);
      // A spaced input redirect followed by an output redirect is not a template.
      const outputRedirect = /\s$/u.test(between) || /\s[0-9]+$/u.test(between);
      return !(/^\s+\S/u.test(between) && outputRedirect && /^(?:&[0-9]+|\s*\S)/u.test(after));
    });
  });
}

function operationRecords(section, prefix, { statusValues = null } = {}) {
  if (section === "- none") return [];
  if (hasUnencodedTemplatePlaceholder(section)) throw new ExecutionContractError(`${prefix} section contains template placeholder content`);
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
  if (value === null || value.length === 0 || /^(?:none|pending|n\/a|not_available)$/iu.test(value) || hasUnencodedTemplatePlaceholder(value)) {
    throw new ExecutionContractError(`${label} must be objective non-placeholder content`);
  }
  return value;
}

function requirePresentValue(value, label) {
  if (value === null || value.length === 0 || /^(?:pending|n\/a)$/iu.test(value) || hasUnencodedTemplatePlaceholder(value)) {
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

function parseCommandTuple(line, label) {
  const match = line.match(/^  - (.+) \| exit:([-]?[0-9]+)$/u);
  if (match === null) throw new ExecutionContractError(`${label} has malformed Commands`);
  let command;
  if (match[1].startsWith("json:")) {
    try { command = JSON.parse(match[1].slice(5)); } catch {
      throw new ExecutionContractError(`${label} has malformed json command`);
    }
    if (typeof command !== "string" || command.length === 0
      || !/[`\r\n]/u.test(command) || `json:${JSON.stringify(command)}` !== match[1]) {
      throw new ExecutionContractError(`${label} has non-canonical json command`);
    }
  } else {
    const plain = match[1].match(/^`([^`\r\n]+)`$/u);
    if (plain === null) throw new ExecutionContractError(`${label} has malformed Commands`);
    command = plain[1];
  }
  const exit = Number(match[2]);
  if (!Number.isSafeInteger(exit)) throw new ExecutionContractError(`${label} command exit must be a safe integer`);
  return Object.freeze({ command, exit });
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
  const commands = lines.map((line) => parseCommandTuple(line, record.id));
  if (commands.length === 0) throw new ExecutionContractError(`${record.id} has no numeric command evidence`);
  if (requireZero && commands.some((entry) => entry.exit !== 0)) {
    throw new ExecutionContractError(`${record.id} PASS commands must exit zero`, [], [],
      { code: "PASS_COMMAND_EXIT_NONZERO", record: record.id, repairability: "runner-result-recovery" });
  }
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
    if (kind === "divergence" && !new Set(["RESUME", "REPLAN"]).has(field(record.body, "Required authority operation"))) {
      throw new ExecutionContractError(`${record.id} has an invalid Required authority operation`);
    }
    if (kind === "divergence") record.requiredAuthorityOperation = field(record.body, "Required authority operation");
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
        if (owner === null) throw new ExecutionContractError(`${record.id} blocking divergence Resolution must name its committed plan revision and recovery slice`);
        record.resolutionRevision = Number(owner[1]);
        record.resolutionSlice = owner[2];
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

const CHECK_FIELD_NAMES = new Set([
  "Automatic check round", "Status", "HEAD", "Tested scope", "Tested state", "Fileless reason", "Discovery sources",
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
  "Type", "Status", "HEAD", "Verified scope", "Commands", "Evidence", "Finding references", "Finding dispositions",
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
    const command = /^  - (?:`[^`\r\n]+`|json:".*") \| exit:[-]?[0-9]+$/u.test(line);
    const testedState = /^  - `[^`]+` \| (?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(line);
    if ((command && owner === "Commands") || (allowTestedState && testedState && owner === "Tested state")) continue;
    throw new ExecutionContractError(`${record.id} has unexpected nested or continuation content under ${owner ?? "no field"}`);
  }
}

const PREPARATION_RECORD_FIELDS = ['Delivery ID', 'Preparation revision', 'Normative sha256', 'Operation attempt ID', 'Origin activation ID'];
function validateRecordFields(record, allowedFields) {
  for (const name of PREPARATION_RECORD_FIELDS) allowedFields.add(name);
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

function parseChecks(section, prefix, context = {}) {
  const records = operationRecords(section, prefix, { statusValues: new Set(["TESTS_PASS", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"]) });
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
    if (record.status === "TESTS_PASS") {
      for (const name of ["Tested scope", "Verification types considered", "Selected checks", "Coverage"]) {
        requireNonPlaceholder(field(record.body, name), `${record.id} ${name}`);
      }
    }
    record.testedState = requireTestedState(record);
    record.commands = requireCommands(record, {
      permitNone: new Set(["TESTS_NOT_APPLICABLE", "BLOCKED"]).has(record.status),
      requireZero: record.status === "TESTS_PASS",
    });
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
        record.correctionPaths = [];
      } else {
        record.correctionPaths = parseInlinePathSet(correctionPaths, `${record.id} Correction paths`);
      }
    }
  }
  let previous = null;
  for (const record of records) {
    const revisedImplementation = prefix === "implementation-check" && previous !== null
      && context.evidenceOrigins?.has(previous.id) && !context.evidenceOrigins.has(record.id)
      && field(previous.body, 'Operation attempt ID') !== field(record.body, 'Operation attempt ID');
    const changedCycle = revisedImplementation || (prefix === "findings-check" && previous !== null && record.findingsCycle !== previous.findingsCycle);
    if (previous === null || changedCycle) {
      if (record.round !== 1) throw new ExecutionContractError(`${record.id} must start its automatic check cycle at round 1/3`);
      if (changedCycle && !revisedImplementation) {
        const priorCycle = Number(previous.findingsCycle.slice("attempt-".length));
        const currentCycle = Number(record.findingsCycle.slice("attempt-".length));
        if (currentCycle <= priorCycle) throw new ExecutionContractError(`${record.id} Findings cycle must move forward`);
      }
    } else if (previous.status === "TESTS_FAIL" && previous.round < 3) {
      if (record.round !== previous.round + 1) throw new ExecutionContractError(`${record.id} must immediately follow ${previous.id} at round ${previous.round + 1}/3`);
    } else if (previous.status === "BLOCKED") {
      if (record.round !== 1) throw new ExecutionContractError(`${record.id} must restart at round 1/3 after ${previous.id} BLOCKED`);
    } else {
      throw new ExecutionContractError(`${record.id} appears after terminal automatic-check record ${previous.id}`);
    }
    if (record.round > 1 && record.correctionPaths.length === 0 && record.testedState.length !== 0) {
      const priorState = new Map(previous?.testedState.map((entry) => [entry.path, entry.expected]) ?? []);
      if (prefix !== "implementation-check" || priorState.size !== record.testedState.length
        || record.testedState.some((entry) => priorState.get(entry.path) !== entry.expected)) {
        throw new ExecutionContractError(`${record.id} file-backed Correction paths cannot be none unless Tested state is unchanged from the prior round`);
      }
    }
    previous = record;
  }
  return records;
}

function baseState(section, attempts) {
  if (section === "- none") return { present: false, paths: [], entries: [] };
  const origin = field(section, "Origin attempt");
  const owningAttempt = attempts.at(-1);
  if (owningAttempt?.id !== origin || owningAttempt?.status !== "PASS") throw new ExecutionContractError("Effective Validation Base does not originate from the latest PASS attempt");
  if (field(section, "Attempt type") !== field(owningAttempt.body, "Type")) throw new ExecutionContractError("Effective Validation Base Attempt type disagrees with its origin attempt");
  if (field(section, "HEAD") !== field(owningAttempt.body, "HEAD")) throw new ExecutionContractError("Effective Validation Base HEAD disagrees with its origin attempt");
  if (field(section, "Result") !== "PASS") throw new ExecutionContractError("Effective Validation Base Result must be PASS");
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
  if (commandLines.length === 0) {
    throw new ExecutionContractError("Effective Validation Base has malformed Authoritative commands");
  }
  const commands = commandLines.map((line) => parseCommandTuple(line, "Effective Validation Base"));
  if (commands.some((entry) => entry.exit !== 0)) {
    throw new ExecutionContractError("Effective Validation Base authoritative commands must exist and exit zero");
  }
  if (JSON.stringify(commands) !== JSON.stringify(owningAttempt.commands)) {
    throw new ExecutionContractError("Effective Validation Base authoritative commands disagree with its origin attempt");
  }
  const evidenceSummary = field(section, "Evidence summary");
  requireNonPlaceholder(evidenceSummary, "Effective Validation Base Evidence summary");
  if (evidenceSummary !== field(owningAttempt.body, "Evidence")) {
    throw new ExecutionContractError("Effective Validation Base Evidence summary disagrees with its origin attempt");
  }
  return { present: true, fileless, paths, entries };
}

function finalState(section) {
  const normalized = normalizeText(section);
  if (normalized === "- pending") return { result: "pending", supersededBy: null, planRevision: null };
  if (normalized === "- PASS") return { result: "PASS", supersededBy: null, planRevision: null };
  const superseded = normalized.match(/^- SUPERSEDED\n- Superseded by: (slice-[0-9]{2,})\n- Plan revision: ([1-9][0-9]*)$/u);
  if (superseded === null || !SLICE_FILE.test(`${superseded[1]}.md`)) throw new ExecutionContractError("Final Result is malformed");
  return { result: "SUPERSEDED", supersededBy: superseded[1], planRevision: Number(superseded[2]) };
}

function parseAttempts(section, reopenedPasses = new Set()) {
  const attempts = operationRecords(section, "attempt", { statusValues: new Set(["PASS", "NEEDS_FIX", "BLOCKED"]) });
  for (const attempt of attempts.slice(0,-1)) if (attempt.status === "PASS" && !reopenedPasses.has(attempt.id)) throw new ExecutionContractError(`${attempt.id} PASS is terminal without a sealed reopening`);
  if (attempts.length > 0 && field(attempts[0].body, "Type") !== "initial") throw new ExecutionContractError("attempt-01 must be initial");
  for (const attempt of attempts.slice(1)) if (field(attempt.body, "Type") !== "revalidation") throw new ExecutionContractError(`${attempt.id} must be revalidation`);
  for (const attempt of attempts) {
    validateNestedScoping(attempt);
    validateRecordFields(attempt, ATTEMPT_FIELD_NAMES);
    for (const name of ["HEAD", "Verified scope", "Evidence", "Finding references", "Finding dispositions", "Blockers", "Unexpected workspace effects", "Persistence summary"]) {
      requirePresentValue(field(attempt.body, name), `${attempt.id} ${name}`);
    }
    attempt.commands = requireCommands(attempt, { permitNone: attempt.status === "BLOCKED", requireZero: attempt.status === "PASS" });
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
  return attempts;
}

function parseDelegationBlocker(section, operationRecordsByName) {
  if (section === "- none") return null;
  if (/<[^>\n]+>/u.test(section)) throw new ExecutionContractError("Delegation Blocker contains template placeholder content");
  const operation = field(section, "Operation");
  const kind = field(section, "Kind");
  const state = field(section, "State");
  const afterRecord = field(section, "After record");
  if (!SLICE_OPERATIONS.has(operation)) throw new ExecutionContractError("Delegation Blocker has invalid Operation");
  if (!new Set(["initialization", "malformed-output"]).has(kind)) throw new ExecutionContractError("Delegation Blocker has invalid Kind");
  if (!new Set(["active", "resolved"]).has(state)) throw new ExecutionContractError("Delegation Blocker has invalid State");
  requireList(section, "Causes", "Delegation Blocker");
  requireNonPlaceholder(field(section, "Required action"), "Delegation Blocker Required action");
  const resolution = field(section, "Resolution", { required: false });
  if (state === "active" && resolution !== null) throw new ExecutionContractError("active Delegation Blocker cannot contain Resolution");
  if (state === "resolved") requireNonPlaceholder(field(section, "Resolution"), "Delegation Blocker Resolution");
  const records = operationRecordsByName.get(operation);
  const priorIndex = afterRecord === "none" ? -1 : records.findIndex((record) => record.id === afterRecord);
  if (afterRecord !== "none" && priorIndex < 0) throw new ExecutionContractError("Delegation Blocker After record does not exist for its Operation");
  if (state === "active" && priorIndex !== records.length - 1) throw new ExecutionContractError("active Delegation Blocker must be resolved after a later valid record");
  if (state === "resolved") {
    if (records.length <= priorIndex + 1) throw new ExecutionContractError("resolved Delegation Blocker requires a later valid record");
    const resolvingRecord = records[priorIndex + 1].id;
    const resolutionText = field(section, "Resolution");
    const namedRecords = [...resolutionText.matchAll(/\b(?:implementation-check|findings-check|attempt)-[0-9]{2,}\b/gu)].map((match) => match[0]);
    if (namedRecords.length !== 1 || namedRecords[0] !== resolvingRecord) {
      throw new ExecutionContractError(`Delegation Blocker Resolution must name ${resolvingRecord}`);
    }
  }
  return { operation, kind, state, afterRecord };
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
      if (resolution === undefined || resolution.index <= origin.index || !new Set(["PASS", "NEEDS_FIX"]).has(resolution.status)) {
        throw new ExecutionContractError(`${finding.id} Resolution must name an existing strictly later formal attempt`);
      }
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
  if (value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === ".") {
    throw new ExecutionContractError(`${label} is not a normalized relative path: ${value}`);
  }
  return value;
}

function delimitedImplementationPathClaims(value, label) {
  const source = String(value);
  const matches = [...source.matchAll(/`([^`\n]+)`/gu)];
  const residue = source.replace(/`[^`\n]+`/gu, "");
  if (residue.includes("`")) throw new ExecutionContractError(`${label} has an unmatched implementation-path delimiter`);
  return matches.map((match) => match[1]);
}

function parseTask(text, label, expectedSlice, references = {}) {
  const { header, body } = parsePurpose(text, label);
  if (!["draft", "ready"].includes(header.get("status"))) throw new ExecutionContractError(`${label} must have draft or ready status`);
  if (header.get("owner") !== "stnl-execution-planner") throw new ExecutionContractError(`${label} has the wrong File Purpose Header owner`);
  const h1 = body.match(/^# ([^\n]+)\n\n/u)?.[1];
  if (!new RegExp(`^Slice ${expectedSlice.slice(6)} Tasks - \\S.*$`, "u").test(h1 ?? "")) {
    throw new ExecutionContractError(`${label} has a non-canonical primary heading`);
  }
  const taskSections = sections(body);
  requireCanonicalSections(taskSections, TASK_SECTIONS, label);
  if (!taskSections.has("References")) throw new ExecutionContractError(`${label} is missing References`);
  const state = authorityFields(taskSections.get("References"), label);
  const continuityFields = [...taskSections.get('Continuity').matchAll(/^- ([^:\n]+): ([^\n]+)$/gmu)];
  if (continuityFields.length !== 4 || continuityFields.map(m=>m[0]).join('\n') !== taskSections.get('Continuity')
    || continuityFields.map(m=>m[1]).join('|') !== 'Current validation|Historical PASS|History source|Current action'
    || !['unvalidated','current','historical','revalidation-required','uncertain'].includes(continuityFields[0][2])
    || !/^(?:none|attempt-[0-9]{2,})$/u.test(continuityFields[1][2])
    || continuityFields[2][2] !== `../continuity.json#${field(taskSections.get('References'),'Delivery ID')}`) {
    throw new ExecutionContractError(`${label} has noncanonical Continuity`);
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
  const implementationChecks = parseChecks(taskSections.get("Implementation Test Evidence"), "implementation-check", {
    artifact: label,
    section: "Implementation Test Evidence",
    evidenceOrigins: references.evidenceOrigins,
    declaredFindingIds,
  });
  const findingsChecks = parseChecks(taskSections.get("Findings Test Evidence"), "findings-check", {
    artifact: label,
    section: "Findings Test Evidence",
    declaredFindingIds,
  });
  const attempts = parseAttempts(taskSections.get("Validation Attempts"),references.reopenedPasses);
  for (const record of [...implementationChecks, ...findingsChecks, ...attempts]) {
    const historical = references.evidenceOrigins?.get(record.id);
    if (field(record.body, 'Delivery ID') !== field(taskSections.get('References'), 'Delivery ID')
      || field(record.body, 'Preparation revision') !== String(historical?.revision ?? references.currentPreparationRevision ?? state.revision)
      || (historical && field(record.body,'Normative sha256') !== historical.normativeSha256)
      || !/^sha256:[a-f0-9]{64}$/u.test(field(record.body, 'Normative sha256'))
      || !/^[a-f0-9-]{36}$/u.test(field(record.body, 'Operation attempt ID'))
      || !/^[a-f0-9-]{36}$/u.test(field(record.body, 'Origin activation ID'))) throw new ExecutionContractError('evidence does not belong to delivery/preparation/attempt');
  }
  const findings = blockerRecords(taskSections.get("Validation Findings"), "finding");
  const divergences = blockerRecords(taskSections.get("Divergences"), "divergence");
  validateFindingLifecycle(findings, attempts, findingsChecks);
  const scopeExpansion = taskSections.get("Scope Expansion");
  if (/^- (?:Operation|Kind|After record|Required action):/mu.test(scopeExpansion)
    || /malformed-output/u.test(scopeExpansion)) {
    throw new ExecutionContractError(`${label} places runner recovery in Scope Expansion instead of Delegation Blocker`);
  }
  const delegationBlocker = parseDelegationBlocker(taskSections.get("Delegation Blocker"), new Map([
    ["EXECUTE_SLICE", implementationChecks], ["APPLY_FINDINGS", findingsChecks], ["VALIDATE_SLICE", attempts],
  ]));
  const base = baseState(taskSections.get("Effective Validation Base"), attempts);
  for (const entry of base.entries) validateRelativeEvidencePath(entry.path, `${label} Effective Validation Base path`);
  const final = finalState(taskSections.get("Final Result"));
  const changedAreasSection = taskSections.get("Changed Areas");
  const changedAreas = changedPathClaims(changedAreasSection, `${label} Changed Areas`, new Set(["- pending", "- none"]));
  const corrections = changedPathClaims(taskSections.get("Corrections Applied"), `${label} Corrections Applied`, new Set(["- none"]));
  if (corrections.some((claim) => !changedAreas.includes(claim))) throw new ExecutionContractError(`${label} correction path is absent from Changed Areas`);
  const changedClaims = [...new Set([...changedAreas, ...corrections])];
  const checklist = taskSections.get("Checklist") ?? "";
  const authorityTask = parsePreparationArtifact(text, `tasks/${expectedSlice}.md`);
  const declaredObligations = authorityTask.sections['Acceptance Obligations'].split('\n').map(line => ({ id: line.split(' | ')[0].slice(2) }));
  const checklistRows = preparationChecklist(checklist, declaredObligations, label);
  const checklistComplete = checklistRows.every((row) => row.done);
  const workStarted = checklistRows.some((row) => row.done) || implementationChecks.length !== 0
    || findingsChecks.length !== 0 || attempts.length !== 0 || corrections.length !== 0
    || delegationBlocker !== null || normalizeText(taskSections.get("Diff Summary")) !== "- pending";
  if (attempts.some(a=>!references.evidenceOrigins?.has(a.id)) && !checklistComplete) throw new ExecutionContractError(`${label} has Validation Attempts before the mandatory checklist is complete`);
  const pristine = [...PRISTINE].every(([name, sentinel]) => taskSections.get(name) === sentinel)
    && !/^- \[x\]/gmu.test(taskSections.get("Checklist") ?? "");
  const activeBlockers = [...findings, ...divergences].filter((record) => record.severity === "blocking" && record.state === "active");
  const activeBlockingDivergence = divergences.some((record) => record.severity === "blocking" && record.state === "active");
  const correctionCycleHasPersistedScope = corrections.length !== 0 && corrections.every((claim) => changedAreas.includes(claim));
  for (const [name, latest] of [["implementation", implementationChecks.at(-1)], ["findings", findingsChecks.at(-1)]]) {
    const expectedOperation = name === "implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS";
    const pausedByDelegation = delegationBlocker?.state === "active" && delegationBlocker.operation === expectedOperation
      && delegationBlocker.afterRecord === latest?.id;
    // Only a prospective private append may leave its admitted failing round
    // open. Publication and official state inspection retain the terminal rule.
    const privateAppend = references.privateAutomaticCheck?.slice === expectedSlice
      && references.privateAutomaticCheck.operation === expectedOperation
      && references.privateAutomaticCheck.round === latest?.round && latest?.status === "TESTS_FAIL";
    // Terminal history may retain its interrupted cycle. executionArtifacts
    // still requires the matching global row and committed later replacement.
    if (latest?.status === "TESTS_FAIL" && latest.round < 3 && final.result !== "SUPERSEDED"
      && !privateAppend && !activeBlockingDivergence && !pausedByDelegation && !correctionCycleHasPersistedScope) {
      throw new ExecutionContractError(`${label} has an unterminated ${name} automatic correction cycle without a blocking divergence`);
    }
  }
  if (attempts.at(-1)?.status === "NEEDS_FIX" && !findings.some((record) => record.severity === "blocking" && record.state === "active")) {
    throw new ExecutionContractError(`${label} latest NEEDS_FIX attempt has no active blocking finding`);
  }
  if (final.result === "PASS" && (!base.present || activeBlockers.length !== 0)) throw new ExecutionContractError(`${label} PASS retains no valid base or active blocker`);
  if (final.result === "PASS" && attempts.at(-1)?.status !== "PASS") throw new ExecutionContractError(`${label} PASS does not originate from its latest formal attempt`);
  if (final.result === "PASS") {
    const diffSummary = normalizeText(taskSections.get("Diff Summary"));
    for (const line of diffSummary.split("\n")) {
      const bullet = line.match(/^- (\S.*)$/u);
      if (bullet === null) {
        throw new ExecutionContractError(`${label} terminal PASS Diff Summary must contain only flat '- ' bullet lines; paragraphs, nested lists and empty lines are invalid`);
      }
      requireNonPlaceholder(bullet[1], `${label} Diff Summary`);
    }
  }
  if (attempts.at(-1)?.status === "PASS" && (final.result !== "PASS" || !base.present) && !references.reopenedPasses?.has(attempts.at(-1).id)) throw new ExecutionContractError(`${label} latest PASS attempt was not published atomically`);
  if (final.result === "SUPERSEDED" && base.present) throw new ExecutionContractError(`${label} SUPERSEDED must not retain an Effective Validation Base`);
  if (final.result === "PASS" && changedClaims.some((claim) => !base.paths.includes(claim))) {
    throw new ExecutionContractError(`${label} has a changed/corrected path with no validation owner`);
  }
  const latestAttempt = attempts.at(-1);
  const latestNeedsFix = attempts.filter((attempt) => attempt.status === "NEEDS_FIX").at(-1);
  let currentAuxiliaryCheck = null;
  if (!base.present) {
    if (latestAttempt === undefined) currentAuxiliaryCheck = implementationChecks.at(-1) ?? null;
    else if (latestAttempt.status === "NEEDS_FIX" || latestAttempt.status === "BLOCKED") {
      currentAuxiliaryCheck = findingsChecks.at(-1) ?? implementationChecks.at(-1) ?? null;
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
    const implementationTerminal = new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(lastImplementation?.status)
      || (lastImplementation?.status === "TESTS_FAIL" && lastImplementation.round === 3);
    const findingsTerminal = new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(lastFindings?.status)
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
  const pendingDelegationScope = delegationBlocker?.state === "active"
    && delegationBlocker.operation === "EXECUTE_SLICE" && delegationBlocker.kind === "malformed-output"
    && delegationBlocker.afterRecord === "none" && implementationChecks.length === 0
    && findingsChecks.length === 0 && attempts.length === 0 && corrections.length === 0
    && !checklistComplete && !base.present;
  if (workStarted && taskSections.get("Changed Areas") === "- pending" && !pendingDelegationScope) {
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
    ...state, body, sections: taskSections, pristine, attempts, findings, divergences, activeBlockers,
    base, final, implementationChecks, findingsChecks, delegationBlocker, retryExhausted, checklistComplete,
    changedAreas, corrections, changedClaims, currentAuxiliaryCheck,
    claims: [...new Set([...changedClaims, ...base.paths])],
    implementationPathClaims: ['Authorized Areas', 'Expected Files', 'Existing Inputs'].flatMap(carrier =>
      preparationPathClaims(authorityTask.sections[carrier], `${label} ${carrier}`).map(raw => ({ field: carrier, raw }))),
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
  const logicalWorkspace = logicalWorkspaceFor(workspace);
  let current = path.dirname(logicalWorkspace.authorityPath);
  for (;;) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return logicalWorkspace.specRoot ?? path.dirname(logicalWorkspace.authorityPath);
}

function implementationPathDiagnostic({ artifact, field, raw, resolved, reason, trustedRoot, existingProjectTarget = null }) {
  const artifactLabel = pathIsWithin(artifact, trustedRoot)
    ? path.relative(trustedRoot, artifact).split(path.sep).join("/") || "."
    : artifact;
  const details = [
    `artifact=${JSON.stringify(artifactLabel)}`,
    `field=${JSON.stringify(field)}`,
    `raw=${JSON.stringify(raw)}`,
    `resolved=${JSON.stringify(resolved)}`,
    `reason=${JSON.stringify(reason)}`,
    `trusted-root=${JSON.stringify(trustedRoot)}`,
  ];
  if (existingProjectTarget !== null) details.push(`existing-project-target=${JSON.stringify(existingProjectTarget)}`);
  return new ExecutionContractError(`invalid artifact-relative implementation path: ${details.join("; ")}`, [artifact, resolved]);
}

function projectRelativeCandidate(raw, trustedRoot) {
  const segments = raw.split("/");
  while (segments[0] === "." || segments[0] === "..") segments.shift();
  return segments.length === 0 ? null : path.resolve(trustedRoot, ...segments);
}

async function resolveImplementationPathClaim(workspace, { artifact, field, raw }) {
  const logicalWorkspace = logicalWorkspaceFor(workspace);
  const logicalArtifact = logicalExecutionPath(workspace, artifact);
  const trustedRoot = await trustedProjectRoot(workspace);
  const resolved = path.resolve(path.dirname(logicalArtifact), raw);
  try {
    validateRelativeEvidencePath(raw, `${field} implementation path`);
  } catch (error) {
    throw implementationPathDiagnostic({
      artifact: logicalArtifact,
      field,
      raw,
      resolved,
      reason: error.message,
      trustedRoot,
    });
  }
  try {
    await rejectSymlinkComponents(resolved, trustedRoot);
  } catch (error) {
    throw implementationPathDiagnostic({
      artifact: logicalArtifact,
      field,
      raw,
      resolved,
      reason: error.message,
      trustedRoot,
    });
  }
  if (pathIsWithin(resolved, logicalWorkspace.executionRoot)) {
    throw implementationPathDiagnostic({
      artifact: logicalArtifact,
      field,
      raw,
      resolved,
      reason: "artifact-relative implementation path resolves inside the execution root",
      trustedRoot,
    });
  }
  if (logicalWorkspace.kind === "lifecycle" && trustedRoot !== logicalWorkspace.specRoot
    && pathIsWithin(resolved, logicalWorkspace.specRoot)) {
    const projectTarget = projectRelativeCandidate(raw, trustedRoot);
    const projectMetadata = projectTarget === null || projectTarget === resolved ? null : await lstatOrNull(projectTarget);
    throw implementationPathDiagnostic({
      artifact: logicalArtifact,
      field,
      raw,
      resolved,
      reason: "artifact-relative implementation path resolves inside the lifecycle SPEC workspace",
      trustedRoot,
      existingProjectTarget: projectMetadata === null ? null : projectTarget,
    });
  }
  const resolvedMetadata = await lstatOrNull(resolved);
  if (resolvedMetadata === null) {
    const projectTarget = projectRelativeCandidate(raw, trustedRoot);
    const projectMetadata = projectTarget === null || projectTarget === resolved ? null : await lstatOrNull(projectTarget);
    if (projectMetadata !== null && !projectMetadata.isSymbolicLink()) {
      await rejectSymlinkComponents(projectTarget, trustedRoot);
      throw implementationPathDiagnostic({
        artifact: logicalArtifact,
        field,
        raw,
        resolved,
        reason: "possible path-basis error: artifact-relative target is absent while the same project-root target exists",
        trustedRoot,
        existingProjectTarget: projectTarget,
      });
    }
  }
  return Object.freeze({
    resolved,
    physicalTarget: resolvedMetadata === null ? resolved : await fs.realpath(resolved),
  });
}

async function validateImplementationPathClaim(workspace, claim) {
  await resolveImplementationPathClaim(workspace, claim);
}

export async function resolvePhysicalImplementationTarget(specPath, { artifact, field = "implementation path", raw }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  return resolveImplementationPathClaim(workspace, {
    artifact: path.resolve(String(artifact)),
    field,
    raw,
  });
}

export async function resolveSemanticPhysicalImplementationTarget(specPath, { raw }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const trustedRoot = await trustedProjectRoot(workspace);
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\\")
    || path.posix.isAbsolute(raw) || path.posix.normalize(raw) !== raw
    || raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ExecutionContractError(
      `semantic physical implementation target must be a normalized repository-relative path: ${String(raw)}`,
      [String(raw)],
    );
  }
  const resolved = path.resolve(trustedRoot, ...raw.split("/"));
  if (!pathIsWithin(resolved, trustedRoot)) {
    throw new ExecutionContractError(`semantic physical implementation target escapes the trusted project root: ${raw}`, [resolved]);
  }
  await rejectSymlinkComponents(resolved, trustedRoot);
  const metadata = await lstatOrNull(resolved);
  return Object.freeze({
    resolved,
    physicalTarget: metadata === null ? resolved : await fs.realpath(resolved),
  });
}

async function validatePlanningImplementationPaths(workspace, globalPlan, plans) {
  const serialRows = canonicalTableRows(
    globalPlan.sections.get("Serial Slice Order"),
    "| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |",
    "|---|---|---|---|---|---|",
    "Serial Slice Order",
  );
  const claims = [];
  const globalArtifact = path.join(workspace.executionRoot, "plan.md");
  for (const line of serialRows) {
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    const slice = columns[0]?.match(/^([0-9]{2,}) - \S.*$/u)?.[1] ?? "unknown";
    for (const raw of delimitedImplementationPathClaims(columns[4], `plan.md Serial Slice Order ${slice} Expected areas`)) {
      claims.push({ artifact: globalArtifact, field: `Serial Slice Order ${slice} Expected areas`, raw });
    }
  }
  for (const [slice, plan] of plans) {
    const artifact = path.join(workspace.executionRoot, "plans", `${slice}.md`);
    for (const raw of delimitedImplementationPathClaims(plan.sections.get("Authorized Areas"), `${slice} plan Likely Areas`)) {
      claims.push({ artifact, field: "Likely Areas", raw });
    }
  }
  for (const claim of claims) await validateImplementationPathClaim(workspace, claim);
}

async function validateTaskImplementationPaths(workspace, tasks) {
  for (const [slice, task] of tasks) {
    const artifact = path.join(workspace.executionRoot, "tasks", `${slice}.md`);
    for (const claim of task.implementationPathClaims) {
      const target = await resolveImplementationPathClaim(workspace, { artifact, ...claim });
      if (claim.field === 'Existing Inputs') {
        const sourceTask = path.join(logicalWorkspaceFor(workspace).executionRoot, 'tasks', `${slice}.md`);
        const relative = path.relative(path.dirname(sourceTask), target.physicalTarget).split(path.sep).join('/');
        const evidence = task.base.present ? task.base.entries : task.currentAuxiliaryCheck?.testedState ?? [];
        const removed = evidence.some(entry => entry.path === relative && entry.expected === 'REMOVED');
        if (removed) {
          // Input existence is required at preparation/admission. A later
          // owned Tested state may prove its removal; its absence is then the
          // observed effect rather than a stale preparation declaration.
          if (await lstatOrNull(target.physicalTarget) !== null) throw new ExecutionContractError('removed existing input is present');
        } else await requireRealFile(target.physicalTarget, 'existing input');
      }
    }
  }
}

function currentCandidateEvidenceOwners(result) {
  const owners = new Map();
  for (const row of result.rows) {
    const task = result.tasks.get(row.slice);
    if (task === undefined) continue;
    const entries = task.base.present ? task.base.entries : task.currentAuxiliaryCheck?.testedState ?? [];
    for (const entry of entries) owners.set(entry.path, row.slice);
    if (task.delegationBlocker?.state === "active" && task.delegationBlocker.kind === "malformed-output"
      && task.delegationBlocker.operation === "EXECUTE_SLICE" && !task.base.present) {
      // The rejected response cannot own current code. Its declared changed
      // scope is pending the next valid runner check, including prior overlaps.
      for (const claim of task.changedClaims) owners.set(claim, row.slice);
    }
  }
  return owners;
}

// A reviewed plan may narrow a directory-shaped expected area to an explicit
// file list. This selects prospective runner scope, never current ownership.
export function closedPlanFileTargets(includedScope) {
  const files = new Set();
  for (const line of String(includedScope).split("\n")) {
    const group = line.match(/^  - `([^`]+)`: (.+)\.$/u);
    if (group === null) continue;
    const names = group[2].split(", ");
    if (names.some((name) => !/^`[^`]+`$/u.test(name))) continue;
    const parts = [group[1], ...names.map((name) => name.slice(1, -1))];
    if (parts.some((part) => part.startsWith("/") || part.includes("\\")
      || part.split("/").some((component) => component === "" || component === "." || component === ".."))) continue;
    for (const name of parts.slice(1)) files.add(path.posix.join(parts[0], name));
  }
  return [...files];
}

function declaredPriorValidationOverlap(section, slice) {
  if (section === "- none") return new Set();
  const declared = new Set();
  const records = (section.startsWith("- Slice ")
    ? section.split("\n")
    : section.split(/(?=^### overlap-[0-9]+$)/mu)).map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const compact = record.match(/^- Slice ([0-9]{2,}) overlap: (.+); (\S[^\n]*)$/u);
    const priorSlice = compact === null
      ? record.match(/^- Prior slice: (slice-[0-9]{2,})$/mu)?.[1]
      : `slice-${compact[1]}`;
    const rawPaths = compact?.[2] ?? record.match(/^- Paths: (.+)$/mu)?.[1];
    if (priorSlice === undefined || rawPaths === undefined
      || (compact === null && (!/^- Affected behavior: \S/mu.test(record) || !/^- Regressions: \S/mu.test(record)))) {
      throw new ExecutionContractError(`${slice} Prior Validation Overlap has an incomplete record`);
    }
    const paths = rawPaths.split(", ").map((raw) => {
      const claim = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
      if (claim.includes("`")) throw new ExecutionContractError(`${slice} Prior Validation Overlap has malformed path claims`);
      return validateRelativeEvidencePath(claim, `${slice} Prior Validation Overlap path`);
    });
    if (new Set(paths).size !== paths.length) {
      throw new ExecutionContractError(`${slice} Prior Validation Overlap contains duplicate path claim: ${paths.find((value, index) => paths.indexOf(value) !== index)}`);
    }
    for (const claim of paths) declared.add(`${priorSlice}\0${claim}`);
  }
  if (records.length === 0) throw new ExecutionContractError(`${slice} Prior Validation Overlap must contain records or - none`);
  return declared;
}

function validatePriorValidationOverlap(result) {
  if (!(result.tasks instanceof Map)) return;
  const priorBases = [];
  for (const row of result.rows) {
    const task = result.tasks.get(row.slice);
    if (task === undefined) continue;
    if (!task.pristine && task.changedAreas.length !== 0) {
      const required = priorBases.flatMap(({ slice, paths }) =>
        task.changedAreas.filter((claim) => paths.has(claim)).map((claim) => `${slice}\0${claim}`));
      const declared = declaredPriorValidationOverlap(task.sections.get("Prior Validation Overlap"), row.slice);
      const missing = required.filter((relation) => !declared.has(relation));
      if (missing.length !== 0) {
        throw new ExecutionContractError(
          `${row.slice} Prior Validation Overlap is missing required prior slice/path coverage: ${missing.map((relation) => relation.replace("\0", " -> ")).join(", ")}`,
        );
      }
    }
    if (row.result === "PASS" && task.base.present) {
      priorBases.push({ slice: row.slice, paths: new Set(task.base.paths) });
    }
  }
}

async function validateCandidateExecutionRecordPaths(result) {
  if (!(result.tasks instanceof Map)) return;
  const logicalWorkspace = logicalWorkspaceFor(result.workspace);
  const trustedRoot = await trustedProjectRoot(result.workspace);
  const currentOwners = currentCandidateEvidenceOwners(result);
  for (const [slice, task] of result.tasks) {
    const artifact = path.join(result.workspace.executionRoot, "tasks", `${slice}.md`);
    const logicalArtifact = logicalExecutionPath(result.workspace, artifact);
    const evidenceOwner = task.base.present ? "Effective Validation Base" : task.currentAuxiliaryCheck?.id ?? null;
    const entries = task.base.present ? task.base.entries : task.currentAuxiliaryCheck?.testedState ?? [];
    const pendingMalformedExecution = task.delegationBlocker?.state === "active"
      && task.delegationBlocker.kind === "malformed-output"
      && task.delegationBlocker.operation === "EXECUTE_SLICE" && !task.base.present;
    if (pendingMalformedExecution) {
      for (const claim of task.changedClaims) {
        await validateImplementationPathClaim(result.workspace, { artifact, field: "Changed Areas pending malformed-output recovery", raw: claim });
      }
    }
    if (entries.length === 0) continue;
    for (const entry of entries) {
      const field = task.base.present ? "Effective Validation Base Files" : `${evidenceOwner} Tested state`;
      await validateImplementationPathClaim(result.workspace, { artifact, field, raw: entry.path });
      const target = path.resolve(path.dirname(logicalArtifact), entry.path);
      const isCurrentOwner = currentOwners.get(entry.path) === slice;
      if (isCurrentOwner && !(pendingMalformedExecution && task.changedClaims.includes(entry.path))) {
        const metadata = await lstatOrNull(target);
        let observed = "absent";
        if (metadata?.isSymbolicLink()) observed = "symlink";
        else if (metadata !== null && !metadata.isFile()) observed = "non-file";
        else if (metadata?.isFile()) observed = `sha256:${createHash("sha256").update(await fs.readFile(target)).digest("hex")}`;
        const matches = entry.expected === "REMOVED"
          ? metadata === null
          : metadata?.isFile() === true && observed === entry.expected;
        if (!matches) {
          throw implementationPathDiagnostic({
            artifact: logicalArtifact,
            field,
            raw: entry.path,
            resolved: target,
            reason: `file-backed candidate evidence expected ${entry.expected} but observed ${observed}`,
            trustedRoot,
          });
        }
      }
    }
    const owned = new Set(entries.map((entry) => entry.path));
    const unowned = task.changedClaims.filter((claim) => !owned.has(claim));
    if (unowned.length !== 0 && !pendingMalformedExecution) {
      throw new ExecutionContractError(
        `${slice} current file-backed candidate evidence does not own every Changed Areas/Corrections Applied path`,
        unowned.map((claim) => path.resolve(path.dirname(logicalArtifact), claim)),
      );
    }
    for (const entry of entries) {
      const resolved = path.resolve(path.dirname(logicalArtifact), entry.path);
      if (!pathIsWithin(resolved, trustedRoot) || pathIsWithin(resolved, logicalWorkspace.executionRoot)) {
        throw implementationPathDiagnostic({
          artifact: logicalArtifact,
          field: `${evidenceOwner} file-backed path`,
          raw: entry.path,
          resolved,
          reason: "candidate evidence path violates project containment",
          trustedRoot,
        });
      }
    }
  }
}

async function validateFinalOwnership(result) {
  const owners = new Map();
  const trustedRoot = await trustedProjectRoot(result.workspace);
  const logicalWorkspace = logicalWorkspaceFor(result.workspace);
  for (const row of result.rows) {
    if (row.result !== "PASS") continue;
    const task = result.tasks.get(row.slice);
    const taskDirectory = path.join(logicalWorkspace.executionRoot, "tasks");
    for (const entry of task.base.entries) {
      const target = path.resolve(taskDirectory, entry.path);
      await rejectSymlinkComponents(target, trustedRoot);
      owners.set(target, { ...entry, slice: row.slice, target });
    }
  }
  const findings = [];
  for (const owner of owners.values()) {
    const metadata = await lstatOrNull(owner.target);
    let observed = "absent";
    if (metadata?.isSymbolicLink()) observed = "symlink";
    else if (metadata !== null && !metadata.isFile()) observed = "non-file";
    else if (metadata?.isFile()) {
      observed = `sha256:${createHash("sha256").update(await fs.readFile(owner.target)).digest("hex")}`;
    }
    if (owner.expected === "REMOVED") {
      if (metadata !== null) findings.push(`${owner.target} (${owner.slice}: expected REMOVED, current ${observed})`);
      continue;
    }
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
      findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current ${observed})`);
      continue;
    }
    if (observed !== `sha256:${owner.hash}`) {
      findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current ${observed})`);
    }
  }
  if (findings.length !== 0) {
    throw new ExecutionContractError(
      "final validation ownership does not match the workspace",
      findings,
      [recoveryTarget("REPLAN", { owner: "terminal-integrity" })],
    );
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

function parseGlobalRows(text) {
  const { header, body } = parsePurpose(text, "tasks.md");
  if (header.get("owner") !== "stnl-execution-planner" || !["draft", "ready"].includes(header.get("status"))) {
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
    rows.push({ done: columns[0] === "[x]", slice: `slice-${sliceMatch[1]}`, validation: columns[5], result: columns[6] });
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
  const logicalWorkspace = logicalWorkspaceFor(workspace);
  const logicalDirectory = logicalExecutionPath(workspace, directory);
  return path.relative(logicalDirectory, logicalWorkspace.authorityPath).split(path.sep).join("/");
}

async function readPlanArtifacts(workspace, { validateImplementationPaths = false } = {}) {
  const globalPlanPath = path.join(workspace.executionRoot, "plan.md");
  await requireRealFile(globalPlanPath, "execution plan.md");
  const globalPlanText = await fs.readFile(globalPlanPath, "utf8");
  const globalPlan = parsePlan(globalPlanText, "plan.md", null, {
    requirementsSource: requirementsReference(workspace, workspace.executionRoot),
  });
  const serialOrder = globalPlan.sections.get("Serial Slice Order");
  const serialRows = canonicalTableRows(
    serialOrder,
    "| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |",
    "|---|---|---|---|---|---|",
    "Serial Slice Order",
  );
  const sliceOrder = serialRows.map((line) => {
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length !== 6) throw new ExecutionContractError(`Serial Slice Order has malformed row: ${line}`);
    const slice = columns[0].match(/^([0-9]{2,}) - \S.*$/u)?.[1];
    if (slice === undefined || columns[5] !== `plans/slice-${slice}.md`) {
      throw new ExecutionContractError(`Serial Slice Order has malformed row: ${line}`);
    }
    return `slice-${slice}`;
  });
  if (new Set(sliceOrder).size !== sliceOrder.length) throw new ExecutionContractError("plan.md has missing or duplicate detailed plan mappings");
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
    plans.set(slice, parsePlan(await fs.readFile(detailedPath, "utf8"), `${slice} plan`, slice, {
      requirementsSource: requirementsReference(workspace, planDirectory),
    }));
  }
  if (validateImplementationPaths) await validatePlanningImplementationPaths(workspace, globalPlan, plans);
  return { globalPlan, globalPlanText, sliceOrder, plans };
}

async function executionArtifacts(workspace, { validateImplementationPaths = false, privateAutomaticCheck = null } = {}) {
  const { globalPlan, sliceOrder, plans } = await readPlanArtifacts(workspace, { validateImplementationPaths });
  const tasksIndexPath = path.join(workspace.executionRoot, "tasks.md");
  await requireRealFile(tasksIndexPath, "execution tasks.md");
  const tasksIndexText = await fs.readFile(tasksIndexPath, "utf8");
  const rows = parseGlobalRows(tasksIndexText);
  const tasks = new Map();
  const continuity = workspace.logicalWorkspace && globalPlan.status === 'draft' && !await lstatOrNull(path.join(workspace.executionRoot,'continuity.json'))
    ? {format:'stnl-delivery-continuity-v1',deliveries:(await preparationAuthorityAt(workspace.executionRoot)).deliveries.map(d=>({...d,baseline:null,history:[],reopen:null}))}
    : await readDeliveryContinuity(workspace);
  const pairMismatches = [];
  for (const row of rows) {
    const taskDirectory = path.join(workspace.executionRoot, "tasks");
    const taskPath = path.join(taskDirectory, `${row.slice}.md`);
    await requireRealFile(taskPath, `${row.slice} detailed task`);
    const delivery = continuity.deliveries.find(d=>d.slice===row.slice);
    const history = await readDeliveryHistory(workspace,delivery,await fs.readFile(taskPath,'utf8'));
    const task = parseTask(history.text, taskPath, row.slice, {
      requirementsSource: requirementsReference(workspace, taskDirectory), privateAutomaticCheck,
      evidenceOrigins:history.evidenceOrigins,reopenedPasses:history.reopenedPasses,currentPreparationRevision:globalPlan.revision,
    });
    task.continuity=delivery;task.history=history.history;task.deliveryId=delivery.deliveryId;
    // A retained preparation snapshot is not itself executed work. Preserve
    // non-pristine status when any archived task actually contains work/evidence.
    if (history.history.some(({text}) => {
      const archived = parsePreparationArtifact(text, `tasks/${row.slice}.md`, {historical:true}).sections;
      return [...PRISTINE].some(([name,sentinel]) => archived[name] !== sentinel)
        || /^- \[x\]/mu.test(archived.Checklist) || archived['Operational Changes'] !== '- none';
    })) task.pristine=false;
    const plan = plans.get(row.slice);
    if (plan !== undefined && (task.fingerprint !== plan.fingerprint || task.revision !== plan.revision)) pairMismatches.push(row.slice);
    if (row.done && row.result === "PASS") {
      if (row.validation !== "PASS" || task.final.result !== "PASS") throw new ExecutionContractError(`${row.slice} PASS row and detailed task disagree`);
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
  if (validateImplementationPaths) await validateTaskImplementationPaths(workspace, tasks);
  const trustedRoot = await trustedProjectRoot(workspace);
  const taskDirectory = path.join(logicalWorkspaceFor(workspace).executionRoot, "tasks");
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
  const pendingReplan = globalPlan.revisionMode !== null && globalPlan.status === "draft";
  if (!pendingReplan && globalPlan.status !== "draft" && (globalPlan.status !== "ready" || [...plans.values()].some((plan) => plan.status !== "ready"))) {
    throw new ExecutionContractError("materialized planning artifacts must all be ready and approved");
  }
  if (globalPlan.revisionMode === null && (rows.length !== sliceOrder.length || rows.some((row, index) => row.slice !== sliceOrder[index]))) {
    throw new ExecutionContractError("plan/task slice mappings or serial order disagree");
  }
  if (globalPlan.revisionMode === null && pairMismatches.length !== 0) throw new ExecutionContractError(`${pairMismatches.join(", ")} plan/task authority does not agree`);
  if (pendingReplan) {
    if (mappingMismatch || pairMismatches.length !== 0) throw new ExecutionContractError('joint REPLAN must include complete paired Tasks and Plans');
    if (globalPlan.revisionMode === 'pristine-replacement') {
      if (globalPlan.revision < 2 || [...tasks.values()].some(task => !task.pristine || task.revision !== globalPlan.revision)
        || globalPlan.supersessionMappings.length !== 0) throw new ExecutionContractError('pristine joint replacement has invalid revision or retained execution history');
    } else if (globalPlan.revisionMode === 'same-delivery-revision') {
      if (globalPlan.revision < 2 || globalPlan.supersessionMappings.length) throw new ExecutionContractError('invalid same-delivery revision');
    } else {
      const historical = rows.filter(row => tasks.get(row.slice).revision < globalPlan.revision);
      const appended = rows.filter(row => tasks.get(row.slice).revision === globalPlan.revision);
      if (!historical.length || !appended.length || Math.max(...historical.map(row => tasks.get(row.slice).revision)) + 1 !== globalPlan.revision
        || appended.some(row => Number(row.slice.slice(6)) <= Math.max(...historical.map(old => Number(old.slice.slice(6)))) || !tasks.get(row.slice).pristine)
        || historical.some(row => plans.get(row.slice).status !== 'ready')
        || appended.some(row => plans.get(row.slice).status !== 'draft')) throw new ExecutionContractError('joint append-only draft lacks preserved history and new pristine deliveries');
      const mapped = new Set(globalPlan.supersessionMappings.map(({source}) => source));
      for (const {source, target} of globalPlan.supersessionMappings) {
        if (!historical.some(row => row.slice === source && !row.done) || !appended.some(row => row.slice === target)) throw new ExecutionContractError('invalid joint supersession mapping');
      }
      if (historical.some(row => !row.done && !mapped.has(row.slice))) throw new ExecutionContractError('joint REPLAN must preserve and map every prior open delivery');
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
    if (tasks.get(row.slice).final.planRevision <= tasks.get(row.slice).revision
      || tasks.get(row.slice).final.planRevision !== tasks.get(replacement).revision
      || tasks.get(row.slice).final.planRevision > globalPlan.revision) {
      throw new ExecutionContractError(`${row.slice} SUPERSEDED Final Result does not name its replacement's committing Plan revision`);
    }
    const laterOwned = new Set(rows.slice(replacementIndex).filter((candidate) => candidate.result === "PASS").flatMap((candidate) => tasks.get(candidate.slice).base.paths));
    const unowned = tasks.get(row.slice).claims.filter((claim) => !laterOwned.has(claim));
    supersededUnowned.push(...unowned.map((claim) => `${row.slice}:${claim}`));
  }
  for (const row of rows) {
    const task = tasks.get(row.slice);
    for (const divergence of task.divergences.filter((record) => record.severity === "blocking" && record.state === "resolved")) {
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
  return { globalPlan, plans, tasks, rows, sliceOrder, pendingReplan, supersededUnowned, continuity };
}

export async function inspectExecutionState(specPath) {
  return inspectExecutionStateWithContext(specPath, null);
}

export async function preparationAuthorityAt(root) {
  return projectPreparationAuthority(await readPreparationArtifacts(root));
}

const continuationHash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function continuationKeys(value, expected, label) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw new ExecutionContractError(`${label} has unknown or missing fields`);
}
function continuationPath(base, relative) {
  if (typeof relative !== 'string' || path.posix.isAbsolute(relative) || relative.includes('\\') || path.posix.normalize(relative) !== relative) throw new ExecutionContractError('noncanonical continuity reference');
  return path.resolve(base, relative);
}
const relativeContinuation = (base, file) => path.relative(base, file).split(path.sep).join('/');

export async function readDeliveryContinuity(workspace, authority = null) {
  const logical = logicalWorkspaceFor(workspace);
  const file = path.join(workspace.executionRoot, 'continuity.json');
  const index = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
  continuationKeys(index, ['format', 'deliveries'], 'continuity');
  if (index.format !== 'stnl-delivery-continuity-v1' || !Array.isArray(index.deliveries)) throw new ExecutionContractError('incompatible continuity');
  const preparation = authority ?? await preparationAuthorityAt(workspace.executionRoot);
  if (JSON.stringify(index.deliveries.map(({slice, deliveryId}) => ({slice, deliveryId}))) !== JSON.stringify(preparation.deliveries)) throw new ExecutionContractError('continuity delivery order/identities differ');
  for (const delivery of index.deliveries) {
    continuationKeys(delivery, ['slice', 'deliveryId', 'baseline', 'history', 'reopen'], 'delivery continuity');
    if (!Array.isArray(delivery.history)) throw new ExecutionContractError('continuity history is not a list');
    if (delivery.baseline !== null) {
      continuationKeys(delivery.baseline, ['allocationRef', 'manifestRef'], 'baseline');
      await readContinuityReference(logical, delivery.baseline.allocationRef, delivery.baseline.manifestRef);
    }
    if (delivery.reopen !== null) {
      continuationKeys(delivery.reopen, ['previousPass', 'reason', 'affectedPaths', 'sourceActivationId'], 'reopen');
      if (!/^attempt-[0-9]{2,}$/u.test(delivery.reopen.previousPass) || typeof delivery.reopen.reason !== 'string' || !delivery.reopen.reason.trim()
        || !/^[a-f0-9-]{36}$/u.test(delivery.reopen.sourceActivationId) || !Array.isArray(delivery.reopen.affectedPaths)
        || JSON.stringify(delivery.reopen.affectedPaths) !== JSON.stringify([...new Set(delivery.reopen.affectedPaths)].sort())) throw new ExecutionContractError('invalid reopening');
      for (const p of delivery.reopen.affectedPaths) continuationPath(await trustedProjectRoot(workspace), p);
    }
    for (const record of delivery.history) {
      continuationKeys(record, ['preparationRevision', 'requirementsAuthority', 'normativeSha256', 'allocationRef', 'taskRef', 'snapshotRef'], 'history');
      continuationKeys(record.taskRef, ['path', 'sha256', 'logicalTaskPath'], 'historical task reference');
      if (record.taskRef.logicalTaskPath !== `tasks/${delivery.slice}.md`) throw new ExecutionContractError('historical task anchor differs');
      await readContinuityReference(logical, record.allocationRef, record.taskRef, true);
      const bytes = await readContinuityReference(logical, record.allocationRef, record.snapshotRef);
      const snapshot = parseStrictJson(bytes.toString('utf8')); validateApprovedPreparation(snapshot,{historical:true});
      if (['preparationRevision', 'requirementsAuthority', 'normativeSha256'].some(k => record[k] !== snapshot[k])
        || !snapshot.deliveries.some(d => d.slice === delivery.slice && d.deliveryId === delivery.deliveryId)) throw new ExecutionContractError('history preparation/identity differs');
    }
  }
  return index;
}

async function readContinuityReference(workspace, allocationRef, fileRef, task = false) {
  continuationKeys(allocationRef, ['path', 'allocationId', 'sha256'], 'allocation reference');
  if (!task) continuationKeys(fileRef, ['path', 'sha256'], 'file reference');
  const marker = continuationPath(workspace.executionRoot, allocationRef.path);
  const allocation = await readRetainedAllocation(marker, workspace.executionRoot, allocationRef);
  const file = continuationPath(workspace.executionRoot, fileRef.path);
  if (!allocation.retention.retainedPaths.some(entry => entry.path === file && entry.sha256 === fileRef.sha256)) throw new ExecutionContractError('reference is not retained by the selected allocation');
  const bytes = (await readOwnedFile(file)).bytes;
  if (continuationHash(bytes) !== fileRef.sha256) throw new ExecutionContractError('continuity reference bytes differ');
  return bytes;
}

export async function readDeliveryHistory(workspace, delivery, currentText) {
  const logical=logicalWorkspaceFor(workspace);
  const evidenceOrigins=new Map();const reopenedPasses=new Set();const cumulative=new Map();
  const archived=[];
  for (const h of delivery.history) archived.push({text:(await readContinuityReference(logical,h.allocationRef,h.taskRef,true)).toString('utf8'),history:h});
  let text=currentText;
  const append=['Implementation Test Evidence','Findings Test Evidence','Validation Attempts'];
  const declarations=['Validation Findings','Divergences'];
  for (const source of [...archived,{text:currentText,history:null}]) {
    const parsed=parsePreparationArtifact(source.text,`tasks/${delivery.slice}.md`,{historical:source.history!==null});
    const priorPass=field(parsed.sections.Continuity,'Historical PASS');
    if (source.history && priorPass!=='none') reopenedPasses.add(priorPass);
    for (const heading of [...append,...declarations]) {
      const records=parsed.sections[heading]==='- none' ? [] : parsed.sections[heading].split(/(?=^### )/mu).filter(r=>r.trim());
      const selected=cumulative.get(heading) ?? new Map();
      for (const record of records) {
        const id=/^### ([a-z-]+-[0-9]{2,})\n/u.exec(record)?.[1];
        if (!id) throw new ExecutionContractError('historical record is malformed');
        if (selected.has(id)) {
          if (append.includes(heading)) throw new ExecutionContractError('current/archived evidence duplicates a sealed identifier');
          const immutable=r=>r.split('\n').filter(line=>!/^- (?:State|Resolution|Superseded by|Resolution slice|Resolution revision):/u.test(line)).join('\n').trim();
          if (immutable(selected.get(id))!==immutable(record)) throw new ExecutionContractError('historical finding origin/description rewritten');
        }
        selected.set(id,record.trim());
        if (source.history && append.includes(heading)) evidenceOrigins.set(id,{revision:Number(parsed.fields['Plan revision']),normativeSha256:source.history.normativeSha256});
      }
      cumulative.set(heading,selected);
    }
  }
  if (delivery.reopen) reopenedPasses.add(delivery.reopen.previousPass);
  for (const [heading,records] of cumulative) text=replaceContinuationSection(text,heading,[...records.values()].join('\n\n') || '- none');
  for (const pass of reopenedPasses) {
    const record=cumulative.get('Validation Attempts')?.get(pass);
    if (!record?.includes('- Status: PASS\n') || !evidenceOrigins.has(pass)) throw new ExecutionContractError('reopening lacks retained historical PASS');
  }
  return {text,evidenceOrigins,reopenedPasses,history:archived};
}

async function knownContinuationControls(workspace, continuity, owner = null, extra = []) {
  const logical = logicalWorkspaceFor(workspace);
  const roots = [logical.executionRoot]; const files = [logical.authorityPath];
  const lock = await executionLockIdentity(logical);
  if (await lstatOrNull(lock.lockPath)) {
    let lease; try {lease = parseStrictJson((await readOwnedFile(lock.lockPath)).bytes.toString('utf8'));} catch {throw new ExecutionContractError('lock already exists with unrecognized ownership; preserve foreign lock');}
    if (lease.format !== 'stnl-execution-lock-v1' || lease.executionRoot !== logical.executionRoot) throw new ExecutionContractError('foreign common lock during capture');
    files.push(lock.lockPath);
  }
  const registryFile = await preparationRegistryPath(logical);
  if (await lstatOrNull(registryFile)) {
    const registry = parseStrictJson((await readOwnedFile(registryFile)).bytes.toString('utf8'));
    if (registry.format !== 'stnl-preparation-registry-v1' || registry.executionRoot !== logical.executionRoot) throw new ExecutionContractError('foreign preparation registry during capture');
    files.push(registryFile);
  }
  if (logical.kind === 'lifecycle') {
    await lifecycleProjection(logical);
    const shared = path.join(logical.specRoot, 'shared');
    if (await lstatOrNull(shared)) for (const name of await fs.readdir(shared)) if (!isIgnoredMetadata(name)) files.push(path.join(shared, name));
  }
  const selected = new Set(extra);
  for (const d of continuity?.deliveries ?? []) {
    if (d.baseline) selected.add(continuationPath(logical.executionRoot, d.baseline.allocationRef.path));
    for (const h of d.history) selected.add(continuationPath(logical.executionRoot, h.allocationRef.path));
  }
  if (owner?.workCapture) selected.add(`${owner.workCapture.path}.owner.json`);
  const fingerprints = [];const allocations=[];
  // Only exact references registered by a producer are followed. Unknown markers
  // encountered inside an approved product area remain product files.
  for (const marker of selected) {
    const captured = await readOwnedFile(marker); const record = parseStrictJson(captured.bytes.toString('utf8'));
    if (record.executionRoot !== logical.executionRoot || !record.allocationId || !record.retentionRoot) throw new ExecutionContractError('unbound operational allocation');
    await classifyOwnedAllocation({workspace:logical,marker});
    const controls = [record.retentionRoot, record.candidate, record.stage, record.backup].filter(Boolean);
    for (const control of controls) {
      await assertNoSymlinkComponents(control, 'operational allocation');
      if (!path.isAbsolute(control) || pathIsWithin(control, logical.executionRoot) || pathIsWithin(logical.executionRoot, control)) throw new ExecutionContractError('operational allocation overlaps authority');
      roots.push(control);
    }
    files.push(marker);
    for (const file of record.controlFiles ?? []) {
      const controlled=parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
      if (!record.owner || ['operationAttemptId','ownershipToken','originActivationId'].some(k=>controlled.owner?.[k]!==record.owner[k])) throw new ExecutionContractError('unbound operational control file');
      files.push(file);
    }
    allocations.push({marker,record});
    if (record.owner?.workCapture && marker !== `${record.owner.workCapture.path}.owner.json`) selected.add(`${record.owner.workCapture.path}.owner.json`);
    fingerprints.push([marker, captured.identity, continuationHash(captured.bytes)]);
    for (const linked of record.knownAllocations ?? []) {
      if (typeof linked !== 'string' || !path.isAbsolute(linked)) throw new ExecutionContractError('invalid producer allocation reference');
      selected.add(linked);
    }
  }
  return { roots, files, fingerprints, allocations };
}

export async function resolveDeliveryVerification({ workspace, authority, delivery }) {
  const logical = logicalWorkspaceFor(workspace), root = await trustedProjectRoot(workspace);
  const artifact = path.join(workspace.executionRoot, 'tasks', `${delivery.slice}.md`);
  const normative = authority.normativeProjection.deliveries.find(d => d.slice === delivery.slice);
  if (!normative || normative.deliveryId !== delivery.deliveryId) throw new ExecutionContractError('verification delivery differs');
  const recipe = parseVerificationRecipe(normative.task['Verification Recipe']);
  const cwd = path.resolve(root, recipe.cwd);
  await rejectSymlinkComponents(cwd, root);
  if (!(await lstatOrNull(cwd))?.isDirectory()) throw new ExecutionContractError('verification cwd must be an existing directory');
  const areas = [], inputs = [];
  for (const [carrier, targets] of [['Authorized Areas', areas], ['Existing Inputs', inputs]]) {
    for (const raw of preparationPathClaims(normative.task[carrier], carrier)) targets.push((await resolveImplementationPathClaim(workspace, {artifact, field:carrier, raw})).resolved);
  }
  const resolved = new Map();
  for (const ref of verificationReferences(recipe)) {
    const target = (await resolveImplementationPathClaim(workspace, {artifact, field:'verification input', raw:ref.path})).resolved;
    if (!(ref.kind === 'input' ? inputs.includes(target) : areas.some(area => pathIsWithin(target, area)))) throw new ExecutionContractError(`verification input ${ref.path} requires a matching ${ref.kind === 'input' ? 'Existing Inputs declaration' : 'Authorized Areas declaration'}`);
    const meta = await lstatOrNull(target);
    if (meta && (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1) || ref.kind === 'input' && !meta) throw new ExecutionContractError('verification reference must be a regular file (existing input must exist)');
    resolved.set(ref.path, target);
  }
  const argument = arg => arg.file ? path.relative(cwd, resolved.get(arg.file.path)).split(path.sep).join('/') : arg.literal;
  // Every direct file arg is constructed from its reviewed reference, never a second free argv.
  const checks = recipe.checks.map(check => ({id:check.id, cwd, executable:check.executable.file ? './' + argument(check.executable) : argument(check.executable), args:check.args.map(argument)}));
  return {format:'stnl-resolved-verification-v1', recipeSha256:continuationHash(JSON.stringify(recipe)), checks};
}
export async function readRunnerVerification(specPath, slice) {
  const current = await readExecutionActivation(specPath);
  const delivery = current.authority.deliveries.find(d => d.slice === slice);
  return resolveDeliveryVerification({workspace:await resolveExecutionWorkspace(specPath), authority:current.authority, delivery});
}

export async function observeRunnerVerificationState(specPath, slice) {
  const current = await readExecutionActivation(specPath), workspace = await resolveExecutionWorkspace(specPath);
  const delivery = current.authority.deliveries.find(d => d.slice === slice);
  const continuity = await readDeliveryContinuity(workspace,current.authority);
  return workImage((await captureContinuationWorkState({workspace,authority:current.authority,delivery,
    owner:current.activation.activeAttempt,continuity,observeOnly:true})).manifest);
}

export async function captureContinuationWorkState({ workspace, authority, delivery, allocation, marker,
  owner = null, continuity = null, knownAllocations = [], sourceActivationId = null, label = 'work', observeOnly = false }) {
  const logical = logicalWorkspaceFor(workspace); const workspaceRoot = await trustedProjectRoot(workspace);
  const artifact = path.join(workspace.executionRoot, 'tasks', `${delivery.slice}.md`);
  const normative = authority.normativeProjection.deliveries.find(d => d.slice === delivery.slice);
  if (!normative || normative.deliveryId !== delivery.deliveryId) throw new ExecutionContractError('capture delivery differs');
  const controls = await knownContinuationControls(workspace, continuity, owner, [...knownAllocations, marker].filter(Boolean));
  const control = file => controls.files.includes(file) || controls.roots.some(root => pathIsWithin(file, root));
  const claims = [];
  for (const carrier of ['Authorized Areas', 'Existing Inputs', 'Expected Files']) {
    const body = normative.task[carrier] ?? (carrier === 'Expected Files' ? '- none' : null);
    if (body === null) throw new ExecutionContractError('capture inputs unavailable');
    for (const raw of preparationPathClaims(body, carrier)) {
      const target = (await resolveImplementationPathClaim(workspace, {artifact, field:carrier, raw})).resolved;
      if (control(target)) throw new ExecutionContractError(`product/input conflicts with control role: ${target}`);
      claims.push(target);
    }
  }
  // Expected files are operational forecasts: take their current authoritative
  // carrier, not the normative projection which intentionally omits it.
  const texts = await readPreparationArtifacts(workspace.executionRoot);
  const task = parsePreparationArtifact(texts.get(`tasks/${delivery.slice}.md`), `tasks/${delivery.slice}.md`);
  for (const raw of preparationPathClaims(task.sections['Expected Files'], 'Expected Files')) {
    const target = (await resolveImplementationPathClaim(workspace, {artifact, field:'Expected Files', raw})).resolved;
    if (control(target)) throw new ExecutionContractError(`expected product conflicts with control: ${target}`);
    claims.push(target);
  }
  await resolveDeliveryVerification({workspace, authority, delivery});
  for (const ref of verificationReferences(parseVerificationRecipe(normative.task['Verification Recipe']))) {
    const target=(await resolveImplementationPathClaim(workspace,{artifact,field:'verification input',raw:ref.path})).resolved;
    if(control(target) || !claims.some(root=>pathIsWithin(target,root))) throw new ExecutionContractError(`verification input ${ref.path} conflicts with control/captured domain`);
  }
  let prior=null;
  if (owner?.workCapture && owner.slice===delivery.slice) prior=await readContinuationWorkCapture(workspace,owner.workCapture,delivery,owner);
  else {
    const baseline=continuity?.deliveries.find(d=>d.slice===delivery.slice)?.baseline;
    if (baseline) prior=await readContinuationWorkCapture(workspace,{path:continuationPath(logical.executionRoot,baseline.manifestRef.path),sha256:baseline.manifestRef.sha256},delivery);
  }
  const priorFiles=(prior?.entries ?? []).filter(e=>['file','absent'].includes(e.kind)).map(e=>continuationPath(workspaceRoot,e.path))
    .filter(file=>claims.some(claim=>pathIsWithin(file,claim)) && !control(file));
  async function inventory(store) {
    const entries = new Map(); let total = 0;
    async function walk(file) {
      if (control(file) || entries.has(file)) return;
      await rejectSymlinkComponents(file, workspaceRoot);
      if (entries.size >= 10000) throw new ExecutionContractError('work capture exceeds bounded file inventory');
      const metadata = await lstatOrNull(file);
      const relative = relativeContinuation(workspaceRoot, file);
      if (!metadata) { entries.set(file, {path:relative, kind:'absent', sha256:null, storedPath:null}); return; }
      if (metadata.isDirectory()) {
        entries.set(file, {path:relative, kind:'directory', sha256:null, storedPath:null});
        for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name));
      } else {
        const bytes = (await readOwnedFile(file)).bytes;
        total += bytes.length;
        if (total > 128 * 1024 * 1024) throw new ExecutionContractError('work capture exceeds bounded byte inventory');
        const hash = continuationHash(bytes);
        const storedPath = observeOnly ? null : path.join(allocation.retentionRoot, `${label}-bytes-${createHash('sha256').update(relative).digest('hex')}`);
        if (store) await fs.writeFile(storedPath, bytes, {flag:'wx', mode:0o600});
        entries.set(file, {path:relative, kind:'file', sha256:hash, storedPath});
      }
    }
    for (const file of claims) await walk(file);
    for (const file of priorFiles) await walk(file);
    return [...entries.values()].sort((a,b) => a.path.localeCompare(b.path,'en'));
  }
  const beforeAuthority = await computeRequirementsAuthority(logical.authorityPath);
  const beforeTree = await captureExecutionTree(logical.executionRoot);
  const entries = await inventory(!observeOnly); const after = await inventory(false);
  if (JSON.stringify(entries) !== JSON.stringify(after) || beforeAuthority !== await computeRequirementsAuthority(logical.authorityPath)
    || JSON.stringify(beforeTree) !== JSON.stringify(await captureExecutionTree(logical.executionRoot))) throw new ExecutionContractError('work/authority changed during capture; retained bytes require diagnosis');
  for (const [file, identity, hash] of controls.fingerprints) {
    const current = await readOwnedFile(file);
    if (JSON.stringify(identity) !== JSON.stringify(current.identity) || hash !== continuationHash(current.bytes)) throw new ExecutionContractError('control identity/role changed during capture');
  }
  const manifest = {format:'stnl-work-continuation-v1', logicalExecutionRoot:logical.executionRoot,
    logicalWorkspaceRoot:workspaceRoot, slice:delivery.slice, deliveryId:delivery.deliveryId,
    operationAttemptId:owner?.operationAttemptId ?? null, sourceActivationId,
    preparationRevision:authority.preparationRevision, requirementsAuthority:authority.requirementsAuthority,
    normativeSha256:authority.normativeSha256, entries};
  if (observeOnly) return {manifest};
  const file = path.join(allocation.retentionRoot, `${label}-manifest.json`);
  const bytes = Buffer.from(JSON.stringify(manifest,null,2)+'\n'); await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
  return {path:file, sha256:continuationHash(bytes), manifest};
}

export async function readContinuationWorkCapture(workspace, reference, delivery, owner = null) {
  continuationKeys(reference, ['path','sha256'], 'work capture');
  const bytes = (await readOwnedFile(reference.path)).bytes;
  if (continuationHash(bytes) !== reference.sha256) throw new ExecutionContractError('work capture hash differs');
  const manifest = parseStrictJson(bytes.toString('utf8'));
  continuationKeys(manifest,['format','logicalExecutionRoot','logicalWorkspaceRoot','slice','deliveryId','operationAttemptId','sourceActivationId','preparationRevision','requirementsAuthority','normativeSha256','entries'],'work manifest');
  const logical = logicalWorkspaceFor(workspace);
  if (manifest.format !== 'stnl-work-continuation-v1' || manifest.logicalExecutionRoot !== logical.executionRoot
    || manifest.logicalWorkspaceRoot !== await trustedProjectRoot(workspace) || manifest.slice !== delivery.slice || manifest.deliveryId !== delivery.deliveryId
    || manifest.operationAttemptId !== (owner?.operationAttemptId ?? null) || !Array.isArray(manifest.entries)) throw new ExecutionContractError('work capture envelope differs');
  let previous = '';
  for (const entry of manifest.entries) {
    continuationKeys(entry,['path','kind','sha256','storedPath'],'work entry');
    continuationPath(manifest.logicalWorkspaceRoot, entry.path);
    if (entry.path.localeCompare(previous,'en') <= 0 || !['file','directory','absent'].includes(entry.kind)) throw new ExecutionContractError('work entry order/kind differs');
    if (entry.kind === 'file') {
      if (!path.isAbsolute(entry.storedPath) || !pathIsWithin(entry.storedPath,path.dirname(reference.path))
        || continuationHash((await readOwnedFile(entry.storedPath)).bytes) !== entry.sha256) throw new ExecutionContractError('retained work bytes differ');
    } else if (entry.sha256 !== null || entry.storedPath !== null) throw new ExecutionContractError('nonfile work entry carries bytes');
    previous = entry.path;
  }
  return manifest;
}

const continuitySummary = (delivery, validity, action) => `- Current validation: ${validity}\n- Historical PASS: ${delivery.reopen?.previousPass ?? 'none'}\n- History source: ../continuity.json#${delivery.deliveryId}\n- Current action: ${action}`;
function replaceContinuationSection(text, heading, body) {
  return text.replace(new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),`$1${body}\n\n`);
}
export async function prepareDeliveryRetention({ specPath, stage, marker, allocation, retentionRoot, revise = false }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const authority = await preparationAuthorityAt(stage);
  const old = await lstatOrNull(path.join(workspace.executionRoot,'continuity.json'))
    ? await readDeliveryContinuity(workspace) : {format:'stnl-delivery-continuity-v1',deliveries:[]};
  const index = {format:'stnl-delivery-continuity-v1',deliveries:authority.deliveries.map(d => {
    const prior = old.deliveries.find(p => p.slice === d.slice && p.deliveryId === d.deliveryId);
    return prior ? structuredClone(prior) : {...d,baseline:null,history:[],reopen:null};
  })};
  allocation.retention = {allocationId:allocation.allocationId, executionRoot:workspace.executionRoot,
    producer:'preparation-publication',owner:null,retainedPaths:[]};
  await persistAllocation(marker,allocation);
  for (const d of old.deliveries) if (d.baseline) {
    const linkedMarker=continuationPath(workspace.executionRoot,d.baseline.allocationRef.path);
    const producer=parseStrictJson((await readOwnedFile(linkedMarker)).bytes.toString('utf8'));
    if (!(producer.knownAllocations ?? []).includes(marker)) await persistAllocation(linkedMarker,{...producer,knownAllocations:[...(producer.knownAllocations ?? []),marker]});
  }
  const references = [];
  async function retain(name, bytes) {
    const file = path.join(retentionRoot,name); await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    return {path:relativeContinuation(workspace.executionRoot,file),sha256:continuationHash(bytes)};
  }
  for (const delivery of index.deliveries) {
    const taskPath = `tasks/${delivery.slice}.md`;
    const task = parsePreparationArtifact(await fs.readFile(path.join(stage,taskPath),'utf8'),taskPath);
    const previousFile = path.join(workspace.executionRoot,taskPath);
    if (revise && await lstatOrNull(previousFile)) {
      const previousBytes = (await readOwnedFile(previousFile)).bytes;
      const previous = parsePreparationArtifact(previousBytes.toString('utf8'),taskPath);
      if (previous.fields['Delivery ID'] !== delivery.deliveryId) throw new ExecutionContractError('revision changes logical delivery identity');
      const previousSnapshot=await lstatOrNull(path.join(workspace.executionRoot,'approved-preparation.json'))
        ? parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'approved-preparation.json'))).bytes.toString('utf8')) : null;
      const affected=previous.fields['Plan revision'] !== task.fields['Plan revision'];
      const hasRecords=['Implementation Test Evidence','Findings Test Evidence','Validation Attempts'].some(h=>previous.sections[h]!=='- none');
      if (previousSnapshot === null) {
        const draft = parseTask(previousBytes.toString('utf8'),previousFile,delivery.slice,{currentPreparationRevision:Number(previous.fields['Plan revision'])});
        if (!draft.pristine || draft.sections.get('Operational Changes') !== '- none') throw new ExecutionContractError('unreviewed draft has executed records without approved preparation');
      }
      if (previousSnapshot !== null && (affected || (hasRecords && previousSnapshot.normativeSha256!==authority.normativeSha256))) {
        const snapshotBytes = (await readOwnedFile(path.join(workspace.executionRoot,'approved-preparation.json'))).bytes;
        const snapshot = parseStrictJson(snapshotBytes.toString('utf8')); validateApprovedPreparation(snapshot);
        const taskRef = {...await retain(`${delivery.slice}-task.md`,previousBytes),logicalTaskPath:taskPath};
        const snapshotRef = await retain(`${delivery.slice}-snapshot.json`,snapshotBytes);
        references.push({delivery,record:{preparationRevision:snapshot.preparationRevision,requirementsAuthority:snapshot.requirementsAuthority,
          normativeSha256:snapshot.normativeSha256,allocationRef:null,taskRef,snapshotRef}});
        // Open blockers remain visible. Compaction is allowed only at a closed boundary.
        const priorDelivery=old.deliveries.find(d=>d.slice===delivery.slice);
        const logicalHistory=await readDeliveryHistory(workspace,priorDelivery,previousBytes.toString('utf8'));
        const parsed = parseTask(logicalHistory.text,previousFile,delivery.slice,{...logicalHistory,currentPreparationRevision:snapshot.preparationRevision});
        if (affected && (parsed.activeBlockers.length || parsed.delegationBlocker?.state === 'active')) throw new ExecutionContractError('open findings/blocker cannot be compacted');
        let text = await fs.readFile(path.join(stage,taskPath),'utf8');
        for (const heading of ['Implementation Test Evidence','Findings Test Evidence','Validation Attempts',...(affected ? ['Operational Changes','Effective Validation Base'] : [])]) text = replaceContinuationSection(text,heading,'- none');
        if (affected) text = replaceContinuationSection(text,'Final Result','- pending');
        const pass = parsed.attempts.filter(a => a.status === 'PASS').at(-1);
        if (pass && affected) delivery.reopen = {previousPass:pass.id,reason:'Approved preparation revised the same delivery',affectedPaths:[],sourceActivationId:allocation.expectedActivationId};
        text = replaceContinuationSection(text,'Continuity',continuitySummary({...delivery,reopen:delivery.reopen ?? (pass ? {previousPass:pass.id} : null)},pass ? affected ? 'revalidation-required' : 'current' : 'unvalidated',affected ? 'validate revised delivery' : 'retain demonstrated current PASS'));
        await fs.writeFile(path.join(stage,taskPath),text);
        let global = await fs.readFile(path.join(stage,'tasks.md'),'utf8');
        if (affected) global = global.split('\n').map(row => row.includes(`| ${taskPath} |`) ? row.replace('| [x] |','| [ ] |').replace('| PASS | PASS |','| pending | pending |') : row).join('\n');
        await fs.writeFile(path.join(stage,'tasks.md'),global);
      }
    }
    if (delivery.baseline === null) {
      const capture = await captureContinuationWorkState({workspace:{...workspace,executionRoot:stage,logicalWorkspace:workspace},authority,delivery,
        allocation,marker,continuity:old,label:`${delivery.slice}-baseline`,sourceActivationId:allocation.expectedActivationId});
      delivery.baseline = {allocationRef:null,manifestRef:{path:relativeContinuation(workspace.executionRoot,capture.path),sha256:capture.sha256}};
      references.push({delivery,baseline:true});
    }
  }
  allocation.retention.retainedPaths = await retainedContinuationFiles(retentionRoot);
  await persistAllocation(marker,allocation);
  const allocationRef = {path:relativeContinuation(workspace.executionRoot,marker),allocationId:allocation.allocationId,sha256:retentionSha256(allocation.retention)};
  for (const r of references) {
    if (r.baseline) r.delivery.baseline.allocationRef = allocationRef;
    else {r.record.allocationRef=allocationRef;r.delivery.history.push(r.record);}
  }
  await fs.writeFile(path.join(stage,'continuity.json'),JSON.stringify(index,null,2)+'\n');
  const snapshotFile=path.join(stage,'approved-preparation.json');
  if (await lstatOrNull(snapshotFile)) {
    const snapshot=parseStrictJson((await readOwnedFile(snapshotFile)).bytes.toString('utf8'));
    const artifacts=await readPreparationArtifacts(stage);const next=projectPreparationAuthority(artifacts);
    if (next.normativeSha256!==snapshot.normativeSha256) throw new ExecutionContractError('retention changed reviewed normative authority');
    snapshot.reviewedArtifacts=[...artifacts].map(([path,utf8])=>({path,sha256:continuationHash(Buffer.from(utf8)),utf8}));
    validateApprovedPreparation(snapshot);await fs.writeFile(snapshotFile,JSON.stringify(snapshot,null,2)+'\n');
  }
}

async function retainedContinuationFiles(root) {
  const files = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const file = path.join(root,name); const bytes = (await readOwnedFile(file)).bytes;
    files.push({path:file,sha256:continuationHash(bytes)});
  }
  return files.sort((a,b) => a.path.localeCompare(b.path,'en'));
}

export function projectOperationalContinuityTask(taskText,delivery) {
  const parsed=parsePreparationArtifact(taskText,`tasks/${delivery.slice}.md`);
  const pass=parsed.sections['Final Result']==='- PASS';
  const attempts=parsed.sections['Validation Attempts']==='- none' ? [] : parsed.sections['Validation Attempts'].split(/(?=^### attempt-)/mu).filter(record=>record.trim());
  const historical=attempts.filter(record=>field(record,'Status')==='PASS').at(-1)?.match(/^### (attempt-[0-9]{2,})\n/u)?.[1];
  const summary=continuitySummary({...delivery,reopen:delivery.reopen ?? (historical ? {previousPass:historical} : null)},pass?'current':delivery.reopen?'revalidation-required':'unvalidated',pass?'delivery validated':'continue admitted operation');
  return replaceContinuationSection(taskText,'Continuity',summary);
}

export async function retainOperationalWork({specPath,stage,marker,allocation,retentionRoot,owner}) {
  const workspace=await resolveExecutionWorkspace(specPath);
  const authority=await preparationAuthorityAt(stage);
  const continuity=await readDeliveryContinuity(workspace);
  const delivery=continuity.deliveries.find(d=>d.slice===owner.slice);
  allocation.retention={allocationId:allocation.allocationId,executionRoot:workspace.executionRoot,producer:'operational-publication',owner,retainedPaths:[]};
  await persistAllocation(marker,allocation);
  const captured=await captureContinuationWorkState({workspace:{...workspace,executionRoot:stage,logicalWorkspace:workspace},authority,delivery,allocation,marker,owner,continuity,
    label:'preserved-product',sourceActivationId:owner.originActivationId});
  allocation.retention.retainedPaths=await retainedContinuationFiles(retentionRoot);await persistAllocation(marker,allocation);
  const taskFile=path.join(stage,`tasks/${owner.slice}.md`);
  const taskText=await fs.readFile(taskFile,'utf8');
  await fs.writeFile(taskFile,projectOperationalContinuityTask(taskText,delivery));
  return async()=>{
    const observed=await captureContinuationWorkState({workspace:{...workspace,executionRoot:stage,logicalWorkspace:workspace},authority,delivery,owner,continuity,observeOnly:true});
    if (workChanges(captured.manifest,observed.manifest).length) throw new ExecutionContractError('product changed after retention capture; preserve candidate/code');
  };
}

async function captureOwnerContinuationWork(workspace, owner, current) {
  const location = await executionLockIdentity(workspace); const allocationId=randomUUID();
  const retentionRoot=path.join(location.parent,`.stnl-execution-backup-${allocationId}`);
  const marker=path.join(location.parent,`.stnl-execution-publication-${allocationId}.json`);
  const allocation={format:'stnl-execution-publication-owner-v1',allocationId,executionRoot:workspace.executionRoot,retentionRoot,
    candidate:null,stage:null,backup:null,owner,knownAllocations:[],retention:{allocationId,executionRoot:workspace.executionRoot,producer:'operation-admission',owner,retainedPaths:[]}};
  await fs.writeFile(marker,JSON.stringify(allocation)+'\n',{flag:'wx',mode:0o600});await fs.mkdir(retentionRoot,{mode:0o700});
  const continuity=await readDeliveryContinuity(workspace,current.authority);
  for (const d of continuity.deliveries) if (d.baseline) {
    const producerMarker=continuationPath(workspace.executionRoot,d.baseline.allocationRef.path);
    const producer=parseStrictJson((await readOwnedFile(producerMarker)).bytes.toString('utf8'));
    await persistAllocation(producerMarker,{...producer,knownAllocations:[...new Set([...(producer.knownAllocations ?? []),marker])]});
  }
  const inherited=current.activation.lastAttempt;
  const delivery=current.authority.deliveries.find(d=>d.slice===owner.slice);
  const capture=await captureContinuationWorkState({workspace,authority:current.authority,delivery,allocation,marker,owner:inherited,
    continuity,label:'owner',sourceActivationId:owner.originActivationId});
  // Capture belongs to the newly admitted operation, even when controls were
  // selected through the previous owner's direct allocation references.
  capture.manifest.operationAttemptId=owner.operationAttemptId;
  const bytes=Buffer.from(JSON.stringify(capture.manifest,null,2)+'\n');await fs.writeFile(capture.path,bytes);
  const reference={path:capture.path,sha256:continuationHash(bytes)};
  allocation.owner={...owner,workCapture:reference};allocation.retention.owner=allocation.owner;
  allocation.retention.retainedPaths=await retainedContinuationFiles(retentionRoot);
  await persistAllocation(marker,allocation);
  await fs.writeFile(`${capture.path}.owner.json`,JSON.stringify(allocation)+'\n',{flag:'wx',mode:0o600});
  return reference;
}

const workImage = manifest => manifest.entries.map(({path,kind,sha256})=>({path,kind,sha256}));
function workChanges(before,after) {
  const a=new Map(workImage(before).map(e=>[e.path,e]));const b=new Map(workImage(after).map(e=>[e.path,e]));
  return [...new Set([...a.keys(),...b.keys()])].filter(p=>JSON.stringify(a.get(p))!==JSON.stringify(b.get(p))).sort();
}
function localPreparationImage(projection,slice) {
  const delivery=structuredClone(projection.deliveries.find(d=>d.slice===slice));
  if (!delivery) throw new ExecutionContractError('historical delivery projection missing');
  for (const carrier of [delivery.plan.References,delivery.task.References]) delete carrier['Plan revision'];
  return {delivery,order:projection.order.find(d=>d.slice===slice),risks:projection.risks,
    objective:projection.global.Objective,strategy:projection.global.Strategy,requirements:projection.global['Requirements authority']};
}

export async function deriveDeliveryValidity({workspace,authority,continuity,delivery,task,owner=null}) {
  const latestPass=task.attempts.filter(a=>a.status==='PASS').at(-1);
  const observed=(await captureContinuationWorkState({workspace,authority,delivery,continuity,owner,observeOnly:true})).manifest;
  if (!delivery.baseline) throw new ExecutionContractError('baseline absent; pristine is unprovable');
  const baselineRef={path:continuationPath(logicalWorkspaceFor(workspace).executionRoot,delivery.baseline.manifestRef.path),sha256:delivery.baseline.manifestRef.sha256};
  const baseline=await readContinuationWorkCapture(workspace,baselineRef,delivery);
  const controls=await knownContinuationControls(workspace,continuity,owner);
  const registered=new Set([...task.implementationChecks,...task.findingsChecks,...task.attempts].map(r=>field(r.body,'Operation attempt ID')));
  if (owner) registered.add(owner.operationAttemptId);
  if (controls.allocations.some(a=>a.record.retention?.producer==='operation-admission' && a.record.owner?.slice===delivery.slice
    && !registered.has(a.record.owner.operationAttemptId))) return {validity:'uncertain',affectedPaths:[],historicalPass:latestPass?.id ?? null,reason:'Unsettled pre-effect owner allocation requires producer diagnosis',observed};
  if (!latestPass) return {validity:'unvalidated',affectedPaths:workChanges(baseline,observed),historicalPass:null,observed};
  if (task.final.result!=='PASS') return {validity:'revalidation-required',affectedPaths:delivery.reopen?.affectedPaths ?? [],historicalPass:latestPass.id,observed};
  const operationId=field(latestPass.body,'Operation attempt ID');
  const source=controls.allocations.find(a=>a.record.retention?.owner?.operationAttemptId===operationId)?.record.retention.owner;
  if (!source?.workCapture) return {validity:'uncertain',affectedPaths:[],historicalPass:latestPass.id,reason:'PASS origin work capture unavailable',observed};
  const captured=await readContinuationWorkCapture(workspace,source.workCapture,delivery,source);
  const affectedPaths=workChanges(captured,observed);
  const originSnapshot=task.history.map(h=>h.history).find(h=>h.normativeSha256===field(latestPass.body,'Normative sha256'));
  let projection=authority.normativeProjection;
  if (originSnapshot) projection=validateApprovedPreparation(parseStrictJson((await readContinuityReference(logicalWorkspaceFor(workspace),originSnapshot.allocationRef,originSnapshot.snapshotRef)).toString('utf8')),{historical:true}).normativeProjection;
  else if (source.normativeSha256!==authority.normativeSha256) return {validity:'uncertain',affectedPaths,historicalPass:latestPass.id,reason:'origin preparation unavailable',observed};
  const equivalent=JSON.stringify(localPreparationImage(projection,delivery.slice))===JSON.stringify(localPreparationImage(authority.normativeProjection,delivery.slice));
  return {validity:affectedPaths.length || !equivalent ? 'revalidation-required' : 'current',affectedPaths,historicalPass:latestPass.id,
    reason:affectedPaths.length ? 'Product or verification inputs changed since formal PASS' : !equivalent ? 'Approved preparation affects the formal proof' : null,observed};
}

export async function inspectDeliveryContinuity(specPath,sliceValue,{revision=null,attempt=null}={}) {
  const slice=`slice-${BigInt(sliceValue).toString().padStart(2,'0')}`;
  const state=await inspectExecutionState(specPath);const task=state.tasks?.get(slice);
  if (!task) throw new ExecutionContractError('delivery is absent');
  if(revision!==null && (!Number.isSafeInteger(revision)||revision<1)) throw new ExecutionContractError('history revision must be a positive integer');
  if(attempt!==null && !/^attempt-[0-9]{2,}$/u.test(attempt)) throw new ExecutionContractError('history attempt must be an exact attempt-NN identifier');
  const selected=attempt===null ? null : task.attempts.find(a=>a.id===attempt && (revision===null || Number(field(a.body,'Preparation revision'))===revision));
  if(attempt!==null && !selected) throw new ExecutionContractError('selected historical attempt/revision is absent');
  const selectedHistory=revision===null ? task.continuity.history : task.continuity.history.filter(h=>h.preparationRevision===revision);
  if(revision!==null && !selectedHistory.length && state.preparation.preparationRevision!==revision) throw new ExecutionContractError('selected historical revision is absent');
  const workspace=await resolveExecutionWorkspace(specPath);
  const allocations=(await knownContinuationControls(workspace,state.continuity,state.activation?.activeAttempt ?? state.activation?.lastAttempt)).allocations;
  const publications=allocations.filter(a=>a.record.confirmation || a.record.cleanup).map(a=>({allocation:a.marker,confirmation:a.record.confirmation ?? null,cleanup:a.record.cleanup ?? null}));
  const ids=records=>records.at(-1)?.id ?? null;
  return {slice,deliveryId:task.deliveryId,preparationRevision:task.revision,state:state.state,
    currentValidation:task.validation?.validity ?? 'unvalidated',historicalPass:task.validation?.historicalPass ?? null,
    latestImplementationCheck:ids(task.implementationChecks),latestFindingsCheck:ids(task.findingsChecks),latestAttempt:ids(task.attempts),
    selection:revision!==null || attempt!==null ? {revision,attempt:selected ? {id:selected.id,status:selected.status,body:selected.body}:null,history:selectedHistory}:null,
    publications,
    history:task.continuity.history.map(h=>({preparationRevision:h.preparationRevision,taskRef:h.taskRef,snapshotRef:h.snapshotRef})),
    reason:task.validation?.reason ?? state.continuityDiagnostics ?? null,affectedPaths:task.validation?.affectedPaths ?? [],
    recoveryTargets:state.recoveryTargets,owner:state.activation?.activeAttempt?.operationAttemptId ?? null};
}

export async function resumeOwnedExecutionOperation(specPath,operation,sliceValue,owner) {
  const workspace=await resolveExecutionWorkspace(specPath);
  return withExecutionPublicationLock(workspace,async()=>{
    const current=await readExecutionActivation(specPath);const active=assertExecutionAttempt(current.activation,owner);
    if (operation!==active.operation || `slice-${BigInt(sliceValue).toString().padStart(2,'0')}`!==active.slice) throw new ExecutionContractError('resume selects another operation/delivery');
    const captured=await readContinuationWorkCapture(workspace,active.workCapture,active,active);
    const continuity=await readDeliveryContinuity(workspace,current.authority);
    const observed=(await captureContinuationWorkState({workspace,authority:current.authority,delivery:active,continuity,owner:active,observeOnly:true})).manifest;
    const changed=workChanges(captured,observed);
    let preserved=null;
    if (changed.length) {
      const marker=`${active.workCapture.path}.owner.json`;const allocation=await readRetainedAllocation(marker,workspace.executionRoot);
      const label=`resume-${randomUUID()}`;
      const capture=await captureContinuationWorkState({workspace,authority:current.authority,delivery:active,continuity,owner:active,allocation,marker,label,sourceActivationId:current.activation.activationId});
      preserved={path:capture.path,sha256:capture.sha256};
      const retained=await retainedContinuationFiles(allocation.retentionRoot);
      // The owner marker itself is a control file, not retained work.
      allocation.retention.retainedPaths=retained.filter(e=>e.path!==marker);
      await persistAllocation(marker,allocation);
    }
    if (active.runner) await readOwnedFile(active.runner.receiptFile);
    return {owner:active,expectedActivationId:current.activation.activationId,runner:active.runner,
      nextAction:active.runner ? 'inspect-existing-runner-and-persist-its-result' : 'continue-owned-work',changedPaths:changed,preservedWork:preserved};
  });
}

export async function readExecutionActivation(specPath, { requireCurrent = true } = {}) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const requirementsAuthority = requireCurrent ? `sha256:${await computeRequirementsAuthority(specPath)}`
    : (await preparationAuthorityAt(workspace.executionRoot)).requirementsAuthority;
  const activated = await readActivatedExecution({ executionRoot: workspace.executionRoot, requirementsAuthority,
    projectAuthority: preparationAuthorityAt, validateSnapshot: validateApprovedPreparation, parseJson: parseStrictJson });
  await validateOperationalChanges(workspace.executionRoot, activated.snapshot);
  await readDeliveryContinuity(workspace,activated.authority);
  for (const owner of [activated.activation.activeAttempt,activated.activation.lastAttempt].filter(Boolean)) {
    await readContinuationWorkCapture(workspace,owner.workCapture,owner,owner);
    const allocation=await readRetainedAllocation(`${owner.workCapture.path}.owner.json`,workspace.executionRoot);
    if (allocation.retention.owner.operationAttemptId!==owner.operationAttemptId) throw new ExecutionContractError('work capture ownership differs');
  }
  return activated;
}

async function inspectExecutionStateWithContext(specPath, logicalWorkspace, options = {}) {
  if (logicalWorkspace !== null) return inspectExecutionStateUnchecked(specPath, logicalWorkspace, options);
  const workspace = await resolveExecutionWorkspace(specPath);
  const marker = await lstatOrNull(path.join(workspace.executionRoot, 'activation.json'));
  const active = marker === null ? null : await readExecutionActivation(specPath, { requireCurrent: false });
  const result = await inspectExecutionStateUnchecked(specPath, null, options);
  if (result.state === 'EMPTY') return result;
  if (active === null && result.globalPlan?.status !== 'draft') {
    throw new ExecutionContractError('incompatible legacy or unactivated ready preparation preserved; joint REVIEW_PLAN activation required');
  }
  if (active !== null) {
    const after = await readExecutionActivation(specPath, { requireCurrent: false });
    if (JSON.stringify(active.activation) !== JSON.stringify(after.activation)) throw new ExecutionContractError('activation changed during state inspection; mixed read blocked');
    return { ...result, activation: after.activation, preparation: after.authority };
  }
  return result;
}

export async function beginPreparedExecutionOperation(specPath, operation, sliceValue, expectedActivationId) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const slice = `slice-${BigInt(sliceValue).toString(10).padStart(2, '0')}`;
  if (operation==='VALIDATE_SLICE') {
    const inspected=await preflightExecutionOperation(specPath,operation,sliceValue);
    if (inspected.activation.activationId!==expectedActivationId) throw new ExecutionContractError('begin activation CAS conflict');
    if (inspected.tasks.get(slice).final.result==='PASS') {
      const reopened=await reopenDeliveryForValidation(specPath,slice,inspected);
      expectedActivationId=reopened.expectedActivationId;
    }
  }
  return beginExecutionOperation({ workspace, operation, slice, expectedActivationId,
    readActivated: () => readExecutionActivation(specPath),
    preflight: () => preflightExecutionOperation(specPath, operation, sliceValue),
    captureWork: (owner,current) => captureOwnerContinuationWork(workspace,owner,current) });
}

async function reopenDeliveryForValidation(specPath,slice,inspected) {
  const workspace=inspected.workspace;
  const task=inspected.tasks.get(slice);
  if (task.validation?.validity!=='revalidation-required' || inspected.activation.activeAttempt) throw new ExecutionContractError('runtime reopening is not justified');
  const candidate=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-revalidation-')));
  await fs.cp(workspace.executionRoot,candidate,{recursive:true});
  const tree=await captureExecutionTree(workspace.executionRoot);
  return publishExecutionUpdate({workspace,candidateExecutionRoot:candidate,expectedTree:tree,
    expectedActivationId:inspected.activation.activationId,readActivated:()=>readExecutionActivation(specPath),
    authorizeDiff:async root=>{if (JSON.stringify((await captureExecutionTree(root)).files)!==JSON.stringify(tree.files)) throw new ExecutionContractError('reopening source changed');},
    prepareRetention:async ({stage,marker,allocation,retentionRoot})=>{
      allocation.retention={allocationId:allocation.allocationId,executionRoot:workspace.executionRoot,producer:'pass-reopening',owner:null,retainedPaths:[]};
      await persistAllocation(marker,allocation);
      const index=await readDeliveryContinuity(workspace);
      const delivery=index.deliveries.find(d=>d.slice===slice);
      for (const d of index.deliveries) if (d.baseline) {
        const baselineMarker=continuationPath(workspace.executionRoot,d.baseline.allocationRef.path);
        const prior=parseStrictJson((await readOwnedFile(baselineMarker)).bytes.toString('utf8'));
        await persistAllocation(baselineMarker,{...prior,knownAllocations:[...new Set([...(prior.knownAllocations ?? []),marker])]});
      }
      const oldTask=(await readOwnedFile(path.join(workspace.executionRoot,`tasks/${slice}.md`))).bytes;
      const snapshot=(await readOwnedFile(path.join(workspace.executionRoot,'approved-preparation.json'))).bytes;
      const taskFile=path.join(retentionRoot,`${slice}-task.md`);const snapshotFile=path.join(retentionRoot,`${slice}-snapshot.json`);
      await fs.writeFile(taskFile,oldTask,{flag:'wx',mode:0o600});await fs.writeFile(snapshotFile,snapshot,{flag:'wx',mode:0o600});
      await captureContinuationWorkState({workspace,authority:inspected.preparation,delivery,allocation,marker,continuity:index,
        owner:inspected.activation.lastAttempt,label:`${slice}-preserved-work`,sourceActivationId:inspected.activation.activationId});
      allocation.retention.retainedPaths=await retainedContinuationFiles(retentionRoot);await persistAllocation(marker,allocation);
      delivery.history.push({preparationRevision:inspected.preparation.preparationRevision,requirementsAuthority:inspected.preparation.requirementsAuthority,
        normativeSha256:inspected.preparation.normativeSha256,
        allocationRef:{path:relativeContinuation(workspace.executionRoot,marker),allocationId:allocation.allocationId,sha256:retentionSha256(allocation.retention)},
        taskRef:{path:relativeContinuation(workspace.executionRoot,taskFile),sha256:continuationHash(oldTask),logicalTaskPath:`tasks/${slice}.md`},
        snapshotRef:{path:relativeContinuation(workspace.executionRoot,snapshotFile),sha256:continuationHash(snapshot)}});
      delivery.reopen={previousPass:task.validation.historicalPass,reason:task.validation.reason,affectedPaths:task.validation.affectedPaths,
        sourceActivationId:inspected.activation.activationId};
      let text=oldTask.toString('utf8');
      for (const heading of ['Implementation Test Evidence','Findings Test Evidence','Validation Attempts','Effective Validation Base']) text=replaceContinuationSection(text,heading,'- none');
      text=replaceContinuationSection(text,'Final Result','- pending');
      text=replaceContinuationSection(text,'Continuity',continuitySummary(delivery,'revalidation-required','validate same delivery'));
      await fs.writeFile(path.join(stage,`tasks/${slice}.md`),text);
      const indexText=await fs.readFile(path.join(stage,'tasks.md'),'utf8');
      await fs.writeFile(path.join(stage,'tasks.md'),indexText.split('\n').map(row=>row.includes(`| tasks/${slice}.md |`)
        ? row.replace('| [x] |','| [ ] |').replace('| PASS | PASS |','| pending | pending |') : row).join('\n'));
      await fs.writeFile(path.join(stage,'continuity.json'),JSON.stringify(index,null,2)+'\n');
    },validateCandidate:async root=>{await validateExecutionCandidate(specPath,root);return preparationAuthorityAt(root);}});
}

async function inspectExecutionStateUnchecked(specPath, logicalWorkspace, {
  validateTerminalOwnership = true,
  validateImplementationPaths = false,
  privateAutomaticCheck = null,
} = {}) {
  const physicalWorkspace = logicalWorkspace === null ? await resolveExecutionWorkspace(specPath)
    : await resolvePhysicalExecutionWorkspace(await fs.realpath(specPath));
  const workspace = logicalWorkspace === null
    ? physicalWorkspace
    : { ...physicalWorkspace, logicalWorkspace };
  const currentFingerprint = await requirementsAuthorityForWorkspace(physicalWorkspace);
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
  const layoutFindings=await findNonCanonicalPathsForWorkspace(physicalWorkspace,{allowPlanned:!hasTasks});
  if(layoutFindings.length) throw new ExecutionContractError(`execution layout contains non-canonical paths: ${layoutFindings.join(', ')}`,layoutFindings);
  if (!hasTasks) {
    const { globalPlan, plans } = await readPlanArtifacts(workspace, { validateImplementationPaths });
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
  const preparation = await preparationAuthorityAt(workspace.executionRoot);
  const artifacts = await executionArtifacts(workspace, { validateImplementationPaths, privateAutomaticCheck });
  const stale = artifacts.globalPlan.fingerprint !== currentFingerprint;
  if (artifacts.globalPlan.status === 'draft') {
    const state = stale ? 'REQUIREMENTS_CHANGED' : artifacts.pendingReplan ? 'PENDING_REPLAN_DRAFT' : 'PLANNED_DRAFT';
    return withRecoveryTargets({ state, workspace, currentFingerprint, stale, ...artifacts, preparation });
  }
  const logical=logicalWorkspaceFor(workspace);
  const activeFile=path.join(logical.executionRoot,'activation.json');
  const image=await lstatOrNull(activeFile) ? parseStrictJson((await readOwnedFile(activeFile)).bytes.toString('utf8')) : null;
  const revalidating=[];const uncertain=[];const unregisteredWork=[];
  for (const delivery of artifacts.continuity.deliveries) {
    const task=artifacts.tasks.get(delivery.slice);
    const validity=await deriveDeliveryValidity({workspace,authority:preparation,continuity:artifacts.continuity,delivery,task,owner:image?.activeAttempt ?? image?.lastAttempt});
    task.validation=validity;
    if (image?.activeAttempt?.slice===delivery.slice || task.sections.get('Operational Changes')!=='- none') task.pristine=false;
    if (task.pristine && validity.affectedPaths.length) {
      const known=new Map();
      for (const [otherSlice,other] of artifacts.tasks) if (otherSlice!==delivery.slice) for (const entry of [...other.base.entries,...(other.currentAuxiliaryCheck?.testedState ?? [])]) {
        known.set(relativeContinuation(await trustedProjectRoot(workspace),path.resolve(logical.executionRoot,'tasks',entry.path)),entry.expected);
      }
      const unexplained=validity.affectedPaths.filter(p=>{
        const observed=validity.observed.entries.find(e=>e.path===p);
        return known.get(p)!==(observed?.kind==='file' ? observed.sha256 : 'REMOVED');
      });
      if (unexplained.length) {task.pristine=false;unregisteredWork.push({slice:delivery.slice,paths:unexplained,owner:image?.activeAttempt?.operationAttemptId ?? null});}
    }
    if (validity.validity==='uncertain') uncertain.push(delivery.slice);
    if (validity.validity==='revalidation-required') {
      revalidating.push(delivery.slice);
      const row=artifacts.rows.find(r=>r.slice===delivery.slice);row.done=false;row.validation='pending';row.result='pending';
    }
  }
  const allPristine = artifacts.rows.every((row) => !row.done && artifacts.tasks.get(row.slice).pristine);
  if (artifacts.pendingReplan) {
    const pendingStale = artifacts.globalPlan.fingerprint !== currentFingerprint;
    const state = pendingStale ? "REQUIREMENTS_CHANGED"
      : artifacts.globalPlan.status === "ready" ? "PENDING_REPLAN_READY" : "PENDING_REPLAN_DRAFT";
    return withRecoveryTargets({ state, workspace, currentFingerprint, stale: pendingStale, ...artifacts });
  }
  const effectiveSlices = artifacts.rows.filter((row) => row.result !== "SUPERSEDED").map((row) => row.slice);
  const activeFindings = effectiveSlices.flatMap((slice) => artifacts.tasks.get(slice).findings.filter((record) => record.severity === "blocking" && record.state === "active").map((record) => `${slice}:${record.id}`));
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
    const handsOffToValidation = new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(record?.status)
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
      && new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(latestCheck.status);
  });
  const implementedAwaitingValidation = effectiveSlices.filter((slice) => {
    const task = artifacts.tasks.get(slice);
    return (task.attempts.length === 0 && new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(task.implementationChecks.at(-1)?.status))
      || (revalidating.includes(slice) && task.checklistComplete && !task.activeBlockers.length);
  });
  const allTerminal = artifacts.rows.every((row) => row.done && new Set(["PASS", "SUPERSEDED"]).has(row.result));
  if (allTerminal && artifacts.supersededUnowned.length !== 0) {
    throw new ExecutionContractError(`SUPERSEDED paths lack later PASS ownership: ${artifacts.supersededUnowned.join(", ")}`);
  }
  const currentPass = artifacts.rows.some((row) => row.result === "PASS"
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
  const result = withRecoveryTargets({
    state, workspace, currentFingerprint, stale, activeFindings, activeDivergences, activeDelegationBlockers,
    exhausted, incompleteExecutionChecklists, auxiliaryBlocked, findingsCorrected, implementedAwaitingValidation,
    validationBlocked, revalidating, uncertain, unregisteredWork, ...artifacts,
  });
  if (uncertain.length || (unregisteredWork.length && !image?.activeAttempt)) return {...result,state:'VALIDATION_BLOCKED',legalOperations:[],normalHandoff:null,
    continuityDiagnostics:uncertain.length ? 'PASS origin is uncertain; retain and inspect referenced material' : 'Work without a proven owner; preserve product and decide recovery'};
  if (validateTerminalOwnership && state === "COMPLETE") await validateFinalOwnership(result);
  return result;
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
    case "PLANNED_READY": targets = [unscoped("REVIEW_PLAN", "planning-authority"), unscoped("REPLAN", "planning-authority")]; break;
    case "PENDING_REPLAN_DRAFT": targets = [unscoped("REVIEW_PLAN", "pending-replan")]; break;
    case "PENDING_REPLAN_READY": targets = [unscoped("REVIEW_PLAN", "pending-replan")]; break;
    case "MATERIALIZED_PRISTINE":
      targets = [
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
      targets = lifecycle.length === 0 ? [unscoped("REPLAN", "active-divergence")]
        : lifecycle.map((entry) => scoped(null, entry.slice, {
          owner: "lifecycle",
          record: entry.record,
          authorityMode: "RESUME",
          invocation: "MODE=RESUME",
        }));
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
          round: prior?.round ?? null,
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
      break;
    case "VALIDATION_BLOCKED":
      targets = [
        ...(result.validationBlocked ?? []).map((slice) => scoped("VALIDATE_SLICE", slice, {
          owner: "validation-attempt", record: result.tasks.get(slice).attempts.at(-1)?.id ?? null,
        })),
        unscoped("REPLAN", "execution-history"),
      ];
      break;
    case "REPLAN_REQUIRED": targets = [unscoped("REPLAN", "current-authority")]; break;
    case "COMPLETE": targets = [unscoped("REPLAN", "complete-execution")]; break;
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
  if (recoveryTargets.some((target) => target.owner === "lifecycle")) return Object.freeze([]);
  const mandatory = recoveryTargets.filter((target) => target.sameOperationResumeRequired);
  if (mandatory.length > 1) throw new ExecutionContractError(`${result.state} has ambiguous mandatory recovery authority`);
  if (mandatory.length === 1) return Object.freeze([simplifiedTarget(mandatory[0])]);
  const legal = [];
  for (const [operation, states] of OPERATION_STATES) {
    if (!states.has(result.state)) continue;
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
    else if (completedOperation === "REVIEW_PLAN" && result.state === "MATERIALIZED_PRISTINE") operation = "EXECUTE_SLICE";
    else if (completedOperation === "EXECUTE_SLICE" && result.state === "IMPLEMENTED_AWAITING_VALIDATION") operation = "VALIDATE_SLICE";
    else if (completedOperation === "APPLY_FINDINGS" && result.state === "FINDINGS_CORRECTED") operation = "VALIDATE_SLICE";
    else if (completedOperation === "VALIDATE_SLICE" && result.state === "VALIDATION_NEEDS_FIX") operation = "APPLY_FINDINGS";
    else if (completedOperation === "VALIDATE_SLICE" && result.state === "EXECUTION_STARTED") operation = "EXECUTE_SLICE";
  } else if (result.state === "EMPTY") operation = "PLAN";
  else if (result.state === "PLANNED_DRAFT") operation = "REVIEW_PLAN";
  else if (result.state === "MATERIALIZED_PRISTINE") operation = "EXECUTE_SLICE";
  else if (result.state === "EXECUTION_STARTED") operation = "EXECUTE_SLICE";
  else if (result.state === "IMPLEMENTED_AWAITING_VALIDATION" || result.state === "FINDINGS_CORRECTED") operation = "VALIDATE_SLICE";
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

function logicalWorkspaceFor(workspace) {
  return workspace.logicalWorkspace ?? workspace;
}

function logicalExecutionPath(workspace, physicalPath) {
  const logicalWorkspace = logicalWorkspaceFor(workspace);
  if (logicalWorkspace === workspace) return physicalPath;
  const relative = path.relative(workspace.executionRoot, physicalPath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new ExecutionContractError(`physical execution path cannot be mapped to the logical workspace: ${physicalPath}`, [physicalPath]);
  }
  return path.join(logicalWorkspace.executionRoot, relative);
}

async function createCandidateShadow(workspace) {
  const shadowRoot = await fs.realpath(await fs.mkdtemp(path.join(
    os.tmpdir(),
    ".stnl-execution-candidate-",
  )));
  try {
    const projectRoot = await trustedProjectRoot(workspace);
    if (pathIsWithin(shadowRoot, projectRoot)) {
      throw new ExecutionContractError(`candidate shadow must be outside the logical project: ${shadowRoot}`, [shadowRoot]);
    }
    if (workspace.kind === "standalone") {
      const authority = path.join(shadowRoot, path.basename(workspace.authorityPath));
      await fs.copyFile(workspace.authorityPath, authority);
      return {
        shadowRoot,
        specPath: authority,
        executionRoot: path.join(shadowRoot, path.basename(workspace.executionRoot)),
      };
    }
    const specRoot = shadowRoot;
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

export async function validateExecutionCandidate(specPath, candidateExecutionRoot, serializedTasks = [], { privateAutomaticCheck = null } = {}) {
  if (privateAutomaticCheck !== null && (!['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(privateAutomaticCheck.operation)
    || ![1, 2].includes(privateAutomaticCheck.round) || serializedTasks.length !== 1
    || serializedTasks[0].slice !== privateAutomaticCheck.slice)) throw new ExecutionContractError("invalid prospective private automatic check");
  const workspace = await resolveExecutionWorkspace(specPath);
  const candidate = path.resolve(String(candidateExecutionRoot));
  await assertNoSymlinkComponents(candidate, "candidate execution root");
  const metadata = await lstatOrNull(candidate);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ExecutionContractError(`candidate execution root must be a real directory: ${candidate}`, [candidate]);
  }
  if (pathIsWithin(candidate, workspace.executionRoot) || pathIsWithin(workspace.executionRoot, candidate)) {
    throw new ExecutionContractError("candidate execution root must be isolated from live execution artifacts", [candidate]);
  }
  await assertCandidateTreeSafe(candidate);
  const shadow = await createCandidateShadow(workspace);
  try {
    await fs.cp(candidate, shadow.executionRoot, { recursive: true });
    for (const { slice, text } of serializedTasks) {
      if (!SLICE_FILE.test(`${slice}.md`) || typeof text !== "string") throw new ExecutionContractError("invalid prospective task serialization");
      await requireRealFile(path.join(candidate, "tasks", `${slice}.md`), "prospective task source");
      await fs.writeFile(path.join(shadow.executionRoot, "tasks", `${slice}.md`), text, "utf8");
    }
    const result = await inspectExecutionStateWithContext(shadow.specPath, workspace, { validateImplementationPaths: true, privateAutomaticCheck });
    const active=(await lstatOrNull(path.join(workspace.executionRoot,'activation.json'))) ? parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'activation.json'))).bytes.toString('utf8')).activeAttempt : null;
    for (const task of result.tasks?.values() ?? []) if (task.final.result==='PASS' && active && field(task.attempts.at(-1).body,'Operation attempt ID')===active.operationAttemptId
      && task.validation?.validity!=='current') throw new ExecutionContractError('new formal PASS does not bind the current product/verification state');
    await validateCandidateExecutionRecordPaths(result);
    validatePriorValidationOverlap(result);
    if ((result.incompleteExecutionChecklists?.length ?? 0) !== 0) {
      const inconsistency = result.incompleteExecutionChecklists[0];
      throw new ExecutionContractError(
        `candidate cannot finalize execution for ${inconsistency.slice} while its mandatory checklist is incomplete`,
        [],
        result.recoveryTargets,
      );
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

// Repair is a restoration of one approved Task, never admission of dirty live bytes.
// Capture identity/metadata too: matching hashes alone do not authorize replacing
// a file changed or replaced by another writer while the candidate was checked.
const repairEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function repairMetadata(metadata, root = false) {
  return { dev: String(metadata.dev), ino: String(metadata.ino), mode: metadata.mode,
    uid: metadata.uid, gid: metadata.gid, nlink: metadata.nlink,
    ...(!root ? { size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs } : {}) };
}
async function captureRepairTree(root) {
  const tree = await captureExecutionTree(root);
  if (tree === null) throw new ExecutionContractError('repair source tree is absent');
  const metadata = [];
  for (const relative of ['', ...tree.files.map(entry => entry.path)]) {
    metadata.push({ path: relative, ...repairMetadata(await fs.lstat(path.join(root, relative)), relative === '') });
  }
  const after = await captureExecutionTree(root);
  if (!repairEqual(after, tree)) throw new ExecutionContractError('repair source changed during capture');
  for (const entry of metadata) {
    const { path: relative, ...before } = entry;
    if (!repairEqual(before, repairMetadata(await fs.lstat(path.join(root, relative)), relative === ''))) {
      throw new ExecutionContractError('repair source metadata changed during capture');
    }
  }
  return { tree, metadata };
}
async function captureRepairRequirements(workspace) {
  const before = repairMetadata(await fs.lstat(workspace.authorityPath));
  const authority = await readOwnedFile(workspace.authorityPath);
  const after = repairMetadata(await fs.lstat(workspace.authorityPath));
  if (!repairEqual(before, after) || before.dev !== authority.identity.dev || before.ino !== authority.identity.ino) {
    throw new ExecutionContractError('repair requirements changed during capture');
  }
  const shared = workspace.kind === 'lifecycle' ? path.join(workspace.specRoot, 'shared') : null;
  return { authority: { metadata: after, sha256: `sha256:${createHash('sha256').update(authority.bytes).digest('hex')}` },
    shared: shared && await lstatOrNull(shared) ? await captureRepairTree(shared) : null };
}

export async function repairExecutionContract(specPath, { checkpoint = null } = {}) {
  try { const result = await inspectExecutionState(specPath); return { status: 'UNCHANGED', repairs: [], state: result.state }; }
  catch (error) {
    const damagedManifest = error.code === 'EXECUTION_PUBLICATION_BLOCKED'
      && error.message === 'execution publication: activation manifest does not cover current artifacts';
    if (!damagedManifest && (!(error instanceof ExecutionContractError) || error.contractViolation?.repairability !== 'mechanical')) throw error;
  }
  const workspace = await resolveExecutionWorkspace(specPath);
  const requirements = await captureRepairRequirements(workspace);
  const source = await captureRepairTree(workspace.executionRoot);
  const markerPath = path.join(workspace.executionRoot, 'activation.json');
  const marker = await readOwnedFile(markerPath);
  const activation = parseStrictJson(marker.bytes.toString('utf8'));
  if (activation.activeAttempt) throw new ExecutionContractError('active/uncertain attempt blocks mechanical repair');
  const requirementsAuthority = `sha256:${await computeRequirementsAuthority(specPath)}`;
  const assertRequirements = async () => {
    if (!repairEqual(await captureRepairRequirements(workspace), requirements)) throw new ExecutionContractError('repair requirements/base changed');
  };
  const assertSource = async root => {
    await assertRequirements();
    if (!repairEqual(await captureRepairTree(root), source)) throw new ExecutionContractError('repair damaged source/base changed');
    const current = await readOwnedFile(path.join(root, 'activation.json'));
    if (!repairEqual(current.identity, marker.identity) || !current.bytes.equals(marker.bytes)) throw new ExecutionContractError('repair expected manifest changed');
  };
  await assertSource(workspace.executionRoot);
  const shadow = await createCandidateShadow(workspace);
  const repairs = [];
  let repairedArtifact = null;
  let finalState;
  let publication;
  try {
    await fs.cp(workspace.executionRoot, shadow.executionRoot, { recursive: true });
    await assertSource(workspace.executionRoot);
    for (;;) {
      try { await inspectExecutionStateWithContext(shadow.specPath, workspace); break; }
      catch (error) {
        if (!(error instanceof ExecutionContractError) || error.contractViolation?.repairability !== 'mechanical') throw error;
        const violation = error.contractViolation;
        const relative = path.relative(shadow.executionRoot, violation.artifact);
        if (!/^tasks\/slice-[0-9]{2,}\.md$/u.test(relative) || (repairedArtifact !== null && relative !== repairedArtifact)) {
          throw new ExecutionContractError('repair must affect one declared task');
        }
        repairedArtifact = relative;
        const applied = applyMechanicalRepair(await fs.readFile(violation.artifact, 'utf8'), violation);
        await fs.writeFile(violation.artifact, applied.text, 'utf8'); repairs.push(applied.repair);
        if (repairs.length > 100) throw new ExecutionContractError('repair exceeds bounded limit');
      }
    }
    if (repairs.length === 0) throw new ExecutionContractError('manifest damage has no recognized lossless Task alias');
    const restored = await captureExecutionTree(shadow.executionRoot);
    const changed = restored.files.filter(entry => !repairEqual(entry, source.tree.files.find(prior => prior.path === entry.path)));
    if (restored.files.length !== source.tree.files.length || changed.length !== 1 || changed[0].path !== repairedArtifact
      || changed[0].sha256 !== activation.artifacts?.find(entry => entry.path === repairedArtifact)?.sha256) {
      throw new ExecutionContractError('repair is not byte-identical to the approved Task manifest');
    }
    const readRestored = async root => {
      const result = await readActivatedExecution({ executionRoot: root, requirementsAuthority,
        projectAuthority: preparationAuthorityAt, validateSnapshot: validateApprovedPreparation, parseJson: parseStrictJson });
      await validateOperationalChanges(root, result.snapshot);
      if (!repairEqual(result.activation, activation)) throw new ExecutionContractError('repair expected activation differs');
      return result;
    };
    // The ordinary strict resolver proves every artifact, snapshot and authority
    // in the restored image. It has no dirty-image option or manifest exception.
    await readRestored(shadow.executionRoot);
    await validateExecutionCandidate(specPath, shadow.executionRoot);
    const assertRestored = async root => {
      if (!repairEqual((await captureExecutionTree(root)).files, restored.files)) throw new ExecutionContractError('repair restored candidate changed');
      await readRestored(root);
    };
    publication = await publishExecutionUpdate({ workspace, candidateExecutionRoot: shadow.executionRoot,
      expectedTree: source.tree, expectedActivationId: activation.activationId,
      readActivated: async () => {
        const current = await readOwnedFile(markerPath);
        if (repairEqual(current.identity, marker.identity) && current.bytes.equals(marker.bytes)) {
          await assertSource(workspace.executionRoot);
          await assertRestored(shadow.executionRoot);
          return readRestored(shadow.executionRoot);
        }
        await assertRequirements();
        const admitted = await readExecutionActivation(specPath);
        const files = entries => entries.filter(entry => entry.path !== 'activation.json');
        if (!repairEqual(files(admitted.tree.files), files(restored.files))) throw new ExecutionContractError('repair readback image changed');
        finalState = (await inspectExecutionState(specPath)).state;
        await assertRequirements();
        return admitted;
      },
      authorizeDiff: async root => { await assertSource(workspace.executionRoot); await assertRestored(root); },
      validateCandidate: async root => { await validateExecutionCandidate(specPath, root); return (await readRestored(root)).authority; },
      checkpoint: async (phase, allocation) => {
        if (checkpoint) await checkpoint(phase, allocation);
        if (phase === 'before-backup') { await assertSource(workspace.executionRoot); await assertRestored(allocation.stage); }
        // Recheck the exact moved image before installing and before activation.
        // A concurrent open writer makes compensation uncertain: retain its bytes.
        if (phase === 'after-backup' || phase === 'before-activation') await assertSource(allocation.backup);
      },
    });
  } catch (error) {
    error.repairCandidate = shadow.executionRoot;
    error.message += `; retained repair candidate ${shadow.executionRoot}`;
    throw error;
  }
  // Confirmed publication is never rolled back because transient cleanup failed.
  try { await fs.rm(shadow.shadowRoot, { recursive: true, force: true }); }
  catch (error) { publication = { ...publication, cleanup: 'pending', cleanupDiagnostics: [...(publication.cleanupDiagnostics ?? []), error.message], retainedCandidate: shadow.executionRoot }; }
  return { status: 'REPAIRED', repairs, state: finalState, ...publication };
}

export async function preflightExecutionOperation(specPath, operation, sliceValue = null, { owner = null } = {}) {
  const normalizedOperation = String(operation);
  const result = await inspectExecutionStateWithContext(specPath, null, {
    validateTerminalOwnership: normalizedOperation !== "REPLAN",
    validateImplementationPaths: new Set(["PLAN", "REVIEW_PLAN", "EXECUTE_SLICE"]).has(normalizedOperation),
  });
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
  if (result.activation?.activeAttempt) {
    if (!owner || !SLICE_OPERATIONS.has(normalizedOperation)) throw new ExecutionContractError('active or uncertain operation blocks conflicting admission');
    assertExecutionAttempt(result.activation, owner);
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
  if (!result.activation?.activeAttempt && !allowed.has(result.state) && !exactMandatoryRecovery) throw recoveryError(normalizedOperation, result);
  if (!result.activation?.activeAttempt && !result.legalOperations.some((target) => target.operation === normalizedOperation && target.slice === slice)) {
    throw recoveryError(normalizedOperation, result);
  }
  const operationTargets = result.recoveryTargets.filter((target) => target.operation === normalizedOperation);
  if (!result.activation?.activeAttempt && operationTargets.length !== 0 && !operationTargets.some((target) => target.slice === slice)) {
    throw recoveryError(normalizedOperation, result);
  }
  if (result.activation?.activeAttempt && (owner.operation !== normalizedOperation || owner.slice !== slice)) throw new ExecutionContractError('owner request differs from admitted operation');
  if (slice !== null && !result.tasks?.has(slice)) throw new ExecutionContractError(`${slice} is absent from the execution artifacts`);
  if (slice !== null) {
    const selectedRow = result.rows.find((row) => row.slice === slice);
    const selectedTask = result.tasks.get(slice);
    const revalidation=normalizedOperation==='VALIDATE_SLICE' && selectedTask.validation?.validity==='revalidation-required';
    if ((selectedRow.done || selectedTask.final.result !== "pending") && !revalidation) throw new ExecutionContractError(`${slice} is terminal and immutable`);
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
  return { ...result, operation: normalizedOperation, slice };
}
