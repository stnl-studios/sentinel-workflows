#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_FILES = new Set(["plan.md", "tasks.md"]);
const ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SLICE_FILE = /^slice-[0-9]{2,}\.md$/u;
const SLICE_OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const OPERATIONS = new Set([
  "PLAN", "REVIEW_PLAN", "MATERIALIZE_TASKS", "REVIEW_TASKS", "REPLAN",
  "EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE",
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
});
const OPERATION_STATES = new Map([
  ["PLAN", new Set(["EMPTY"])],
  ["REVIEW_PLAN", new Set(["PLANNED_DRAFT", "PLANNED_READY", "PENDING_REPLAN_DRAFT", "PENDING_REPLAN_READY"])],
  ["MATERIALIZE_TASKS", new Set(["PLANNED_READY", "PENDING_REPLAN_READY"])],
  ["REVIEW_TASKS", new Set(["MATERIALIZED_PRISTINE"])],
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
      if (record.round !== previous.round + 1) throw new ExecutionContractError(`${record.id} must immediately follow ${previous.id} at round ${previous.round + 1}/3`);
    } else if (previous.status === "BLOCKED") {
      if (record.round !== 1) throw new ExecutionContractError(`${record.id} must restart at round 1/3 after ${previous.id} BLOCKED`);
    } else {
      throw new ExecutionContractError(`${record.id} appears after terminal automatic-check record ${previous.id}`);
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
  if (commandLines.length === 0 || commandLines.some((line) => !/^  - `[^`]+` \| exit:[-]?[0-9]+$/u.test(line))) {
    throw new ExecutionContractError("Effective Validation Base has malformed Authoritative commands");
  }
  const commands = commandLines.map((line) => {
    const match = line.match(/^  - `([^`]+)` \| exit:([-]?[0-9]+)$/u);
    return Object.freeze({ command: match[1], exit: Number(match[2]) });
  });
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

function parseAttempts(section) {
  const attempts = operationRecords(section, "attempt", { statusValues: new Set(["PASS", "NEEDS_FIX", "BLOCKED"]) });
  const firstPassIndex = attempts.findIndex((attempt) => attempt.status === "PASS");
  if (firstPassIndex >= 0 && firstPassIndex !== attempts.length - 1) {
    throw new ExecutionContractError(`${attempts[firstPassIndex].id} PASS is terminal; no later formal attempt is permitted`);
  }
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
    declaredFindingIds,
  });
  const findingsChecks = parseChecks(taskSections.get("Findings Test Evidence"), "findings-check", {
    artifact: label,
    section: "Findings Test Evidence",
    declaredFindingIds,
  });
  const attempts = parseAttempts(taskSections.get("Validation Attempts"));
  const findings = blockerRecords(taskSections.get("Validation Findings"), "finding");
  const divergences = blockerRecords(taskSections.get("Divergences"), "divergence");
  validateFindingLifecycle(findings, attempts, findingsChecks);
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
  const checklistRows = checklist.split("\n").filter((line) => line.length !== 0).map((line) => {
    const match = line.match(/^- \[([ x])\] ([0-9]+\.[0-9]+) \S.* \| observable result: \S.* \| expected areas: \S.* \| requirement: \S.*$/u);
    if (match === null) throw new ExecutionContractError(`${label} has malformed Checklist row: ${line}`);
    const expectedAreas = line.match(/\| expected areas: (\S.*?) \| requirement: /u)?.[1];
    if (expectedAreas === undefined) throw new ExecutionContractError(`${label} has malformed Checklist expected areas: ${line}`);
    return {
      done: match[1] === "x",
      id: match[2],
      implementationPathClaims: delimitedImplementationPathClaims(expectedAreas, `${label} Checklist ${match[2]} expected areas`),
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
  const activeBlockers = [...findings, ...divergences].filter((record) => record.severity === "blocking" && record.state === "active");
  const activeBlockingDivergence = divergences.some((record) => record.severity === "blocking" && record.state === "active");
  const correctionCycleHasPersistedScope = corrections.length !== 0 && corrections.every((claim) => changedAreas.includes(claim));
  for (const [name, latest] of [["implementation", implementationChecks.at(-1)], ["findings", findingsChecks.at(-1)]]) {
    const expectedOperation = name === "implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS";
    const pausedByDelegation = delegationBlocker?.state === "active" && delegationBlocker.operation === expectedOperation
      && delegationBlocker.afterRecord === latest?.id;
    if (latest?.status === "TESTS_FAIL" && latest.round < 3 && !activeBlockingDivergence
      && !pausedByDelegation && !correctionCycleHasPersistedScope) {
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
    if (!/^- \S.*$/u.test(diffSummary) || /^(?:- )?(?:none|pending|n\/a|not_available)$/iu.test(diffSummary)) {
      throw new ExecutionContractError(`${label} terminal PASS requires a non-placeholder Diff Summary`);
    }
  }
  if (attempts.at(-1)?.status === "PASS" && (final.result !== "PASS" || !base.present)) throw new ExecutionContractError(`${label} latest PASS attempt was not published atomically`);
  if (final.result === "SUPERSEDED" && base.present) throw new ExecutionContractError(`${label} SUPERSEDED must not retain an Effective Validation Base`);
  if (final.result === "PASS" && changedClaims.some((claim) => !base.paths.includes(claim))) {
    throw new ExecutionContractError(`${label} has a changed/corrected path with no validation owner`);
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
    ...state, body, sections: taskSections, pristine, attempts, findings, divergences, activeBlockers,
    base, final, implementationChecks, findingsChecks, delegationBlocker, retryExhausted, checklistComplete,
    changedAreas, corrections, changedClaims, currentAuxiliaryCheck,
    claims: [...new Set([...changedClaims, ...base.paths])],
    implementationPathClaims: checklistRows.flatMap((row) => row.implementationPathClaims.map((raw) => ({
      field: `Checklist ${row.id} expected areas`, raw,
    }))),
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
    "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |",
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
    for (const raw of delimitedImplementationPathClaims(plan.sections.get("Likely Areas"), `${slice} plan Likely Areas`)) {
      claims.push({ artifact, field: "Likely Areas", raw });
    }
  }
  for (const claim of claims) await validateImplementationPathClaim(workspace, claim);
}

async function validateTaskImplementationPaths(workspace, tasks) {
  for (const [slice, task] of tasks) {
    const artifact = path.join(workspace.executionRoot, "tasks", `${slice}.md`);
    for (const claim of task.implementationPathClaims) {
      await validateImplementationPathClaim(workspace, { artifact, ...claim });
    }
  }
}

function currentCandidateEvidenceOwners(result) {
  const owners = new Map();
  for (const row of result.rows) {
    const task = result.tasks.get(row.slice);
    if (task === undefined) continue;
    const entries = task.base.present
      ? task.base.entries
      : task.currentAuxiliaryCheck?.testedState ?? [];
    for (const entry of entries) owners.set(entry.path, row.slice);
  }
  return owners;
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
    if (entries.length === 0) continue;
    for (const entry of entries) {
      const field = task.base.present ? "Effective Validation Base Files" : `${evidenceOwner} Tested state`;
      await validateImplementationPathClaim(result.workspace, { artifact, field, raw: entry.path });
      const target = path.resolve(path.dirname(logicalArtifact), entry.path);
      const isCurrentOwner = currentOwners.get(entry.path) === slice;
      if (isCurrentOwner) {
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
    if (unowned.length !== 0) {
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
    "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |",
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

async function executionArtifacts(workspace, { validateImplementationPaths = false } = {}) {
  const { globalPlan, sliceOrder, plans } = await readPlanArtifacts(workspace, { validateImplementationPaths });
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
    const laterOwned = new Set(rows.slice(replacementIndex).filter((candidate) => candidate.result === "PASS").flatMap((candidate) => tasks.get(candidate.slice).base.paths));
    const unowned = tasks.get(row.slice).claims.filter((claim) => !laterOwned.has(claim));
    supersededUnowned.push(...unowned.map((claim) => `${row.slice}:${claim}`));
  }
  for (const row of rows) {
    const task = tasks.get(row.slice);
    if (row.result === "SUPERSEDED" && task.divergences.some((record) => record.severity === "blocking" && record.state === "active")) {
      throw new ExecutionContractError(`${row.slice} SUPERSEDED history retains an undisposed blocking divergence`);
    }
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
  return { globalPlan, plans, tasks, rows, sliceOrder, pendingReplan, supersededUnowned };
}

export async function inspectExecutionState(specPath) {
  return inspectExecutionStateWithContext(specPath, null);
}

async function inspectExecutionStateWithContext(specPath, logicalWorkspace, {
  validateTerminalOwnership = true,
  validateImplementationPaths = false,
} = {}) {
  const physicalWorkspace = await resolveExecutionWorkspace(specPath);
  const workspace = logicalWorkspace === null
    ? physicalWorkspace
    : { ...physicalWorkspace, logicalWorkspace };
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
  const artifacts = await executionArtifacts(workspace, { validateImplementationPaths });
  const stale = artifacts.globalPlan.fingerprint !== currentFingerprint;
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
    return task.attempts.length === 0 && new Set(["TESTS_PASS", "TESTS_NOT_APPLICABLE"]).has(task.implementationChecks.at(-1)?.status);
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
    validationBlocked, ...artifacts,
  });
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
  } else if (result.state === "EMPTY") operation = "PLAN";
  else if (result.state === "PLANNED_DRAFT") operation = "REVIEW_PLAN";
  else if (result.state === "PLANNED_READY") operation = "MATERIALIZE_TASKS";
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

export async function validateExecutionCandidate(specPath, candidateExecutionRoot) {
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
    const result = await inspectExecutionStateWithContext(shadow.specPath, workspace, { validateImplementationPaths: true });
    await validateCandidateExecutionRecordPaths(result);
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
        candidateState = await inspectExecutionStateWithContext(shadow.specPath, workspace);
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
  const result = await inspectExecutionStateWithContext(specPath, null, {
    validateTerminalOwnership: normalizedOperation !== "REPLAN",
    validateImplementationPaths: new Set(["MATERIALIZE_TASKS", "EXECUTE_SLICE"]).has(normalizedOperation),
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
  return { ...result, operation: normalizedOperation, slice };
}
