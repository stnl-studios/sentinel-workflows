#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const ROOT_FILES = new Set(["plan.md", "tasks.md"]);
const ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SLICE_FILE = /^slice-[0-9]{2,}\.md$/u;
const SLICE_OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const OPERATIONS = new Set([
  "PLAN", "REVIEW_PLAN", "MATERIALIZE_TASKS", "REVIEW_TASKS", "REPLAN",
  "EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE", "CLOSE",
]);
const RECOVERY_OPERATIONS = new Map([
  ["EMPTY", ["PLAN"]], ["PLANNED_DRAFT", ["REVIEW_PLAN"]], ["PLANNED_READY", ["MATERIALIZE_TASKS"]],
  ["PENDING_REPLAN_DRAFT", ["REVIEW_PLAN"]], ["PENDING_REPLAN_READY", ["MATERIALIZE_TASKS"]],
  ["MATERIALIZED_PRISTINE", ["REVIEW_TASKS", "EXECUTE_SLICE", "REPLAN"]],
  ["EXECUTION_STARTED", ["EXECUTE_SLICE", "REPLAN"]],
  ["REQUIREMENTS_CHANGED", ["REPLAN"]], ["DIVERGENCE_BLOCKED", ["REPLAN"]],
  ["AUXILIARY_BLOCKED", ["originating EXECUTE_SLICE or APPLY_FINDINGS"]],
  ["RUNNER_INITIALIZATION_BLOCKED", ["originating slice operation"]],
  ["RUNNER_RESULT_BLOCKED", ["originating slice operation"]],
  ["IMPLEMENTATION_RETRY_EXHAUSTED", ["VALIDATE_SLICE"]], ["FINDINGS_RETRY_EXHAUSTED", ["VALIDATE_SLICE"]],
  ["IMPLEMENTED_AWAITING_VALIDATION", ["VALIDATE_SLICE", "REPLAN"]], ["FINDINGS_CORRECTED", ["VALIDATE_SLICE", "REPLAN"]],
  ["VALIDATION_NEEDS_FIX", ["APPLY_FINDINGS"]], ["VALIDATION_BLOCKED", ["VALIDATE_SLICE", "REPLAN"]],
  ["REPLAN_REQUIRED", ["REPLAN"]], ["COMPLETE", ["CLOSE", "REPLAN"]],
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
  constructor(message, findings = []) {
    super(message);
    this.name = "ExecutionContractError";
    this.findings = findings;
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
  const matches = [...String(body).matchAll(new RegExp(`^- ${escaped}: (.+)$`, "gmu"))];
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) throw new ExecutionContractError(`expected exactly one '${name}' field`);
  return matches[0][1].trim();
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

function parsePlan(text, label, expectedSlice = null, references = {}) {
  const { header, body } = parsePurpose(text, label);
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
  if (value === null || /^(?:none|pending|n\/a|not_available)$/iu.test(value) || /<[^>\n]+>/u.test(value)) {
    throw new ExecutionContractError(`${label} must be objective non-placeholder content`);
  }
  return value;
}

function requirePresentValue(value, label) {
  if (value === null || /^(?:pending|n\/a)$/iu.test(value) || /<[^>\n]+>/u.test(value)) {
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
  const none = field(record.body, "Commands", { required: false });
  const commandLines = [...record.body.matchAll(/^  - `[^`]+` \| exit:([-]?[0-9]+)$/gmu)].map((match) => Number(match[1]));
  if (none !== null) {
    if (!permitNone || none !== "none" || commandLines.length !== 0) throw new ExecutionContractError(`${record.id} has invalid Commands`);
    return [];
  }
  if (!/^- Commands:$/mu.test(record.body) || commandLines.length === 0) throw new ExecutionContractError(`${record.id} has no numeric command evidence`);
  if (requireZero && commandLines.some((value) => value !== 0)) throw new ExecutionContractError(`${record.id} PASS commands must exit zero`);
  return commandLines;
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

function parseChecks(section, prefix) {
  const records = operationRecords(section, prefix, { statusValues: new Set(["TESTS_PASS", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"]) });
  for (const record of records) {
    const round = field(record.body, "Automatic check round").match(/^([123])\/3$/u);
    if (round === null) throw new ExecutionContractError(`${record.id} has invalid Automatic check round`);
    record.round = Number(round[1]);
    for (const name of ["HEAD", "Tested scope", "Discovery sources", "Discovery actions", "Verification types considered", "Selected checks", "Selection rationale", "Coverage", "Failures", "Blockers", "Unexpected workspace effects", "Persistence summary"]) {
      requirePresentValue(field(record.body, name), `${record.id} ${name}`);
    }
    const testedState = requireList(record.body, "Tested state", record.id);
    if (testedState.some((value) => !/^`[^`]+` \| (?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(value))) {
      throw new ExecutionContractError(`${record.id} has malformed Tested state`);
    }
    const commandExits = requireCommands(record, {
      permitNone: new Set(["TESTS_NOT_APPLICABLE", "BLOCKED"]).has(record.status),
      requireZero: record.status === "TESTS_PASS",
    });
    if (record.status === "TESTS_FAIL" && !commandExits.some((value) => value !== 0)) {
      throw new ExecutionContractError(`${record.id} TESTS_FAIL must contain a nonzero command exit`);
    }
    if (record.status === "TESTS_NOT_APPLICABLE") {
      if (field(record.body, "Commands") !== "none") throw new ExecutionContractError(`${record.id} TESTS_NOT_APPLICABLE Commands must be none`);
      requireNonPlaceholder(field(record.body, "Non-applicability rationale"), `${record.id} Non-applicability rationale`);
      requireNonPlaceholder(field(record.body, "No verification-command confirmation"), `${record.id} No verification-command confirmation`);
    }
    if (prefix === "findings-check") {
      record.findingsCycle = field(record.body, "Findings cycle");
      if (!/^attempt-[0-9]{2,}$/u.test(record.findingsCycle)) throw new ExecutionContractError(`${record.id} has invalid Findings cycle`);
      for (const name of ["Finding IDs", "Findings verified", "Corrections covered", "Regressions", "Unsupported active findings"]) {
        requirePresentValue(field(record.body, name), `${record.id} ${name}`);
      }
    }
    if (record.round > 1) {
      for (const name of ["Prior-round failure", "Correction applied", "Correction paths", "Updated scope", "In-slice rationale"]) {
        requireNonPlaceholder(field(record.body, name), `${record.id} ${name}`);
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
  const filesMarker = section.indexOf("- Files:");
  const commandsMarker = section.indexOf("- Authoritative commands:");
  const evidenceMarker = section.indexOf("- Evidence summary:");
  if (filesMarker < 0 || commandsMarker <= filesMarker || evidenceMarker <= commandsMarker) throw new ExecutionContractError("Effective Validation Base field order is malformed");
  const filesSection = section.slice(filesMarker, commandsMarker).trimEnd();
  const fileLines = filesSection.split("\n").slice(1).filter((line) => line.length !== 0);
  if (fileLines.length === 0 || fileLines.some((line) => !/^  - `[^`]+` \| (?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(line))) {
    throw new ExecutionContractError("Effective Validation Base has a malformed Files manifest");
  }
  const entries = [];
  for (const match of filesSection.matchAll(/^  - `([^`]+)` \| (sha256:([0-9a-f]{64})|REMOVED)$/gmu)) {
    entries.push({ path: match[1], expected: match[2], hash: match[3] ?? null });
  }
  const paths = entries.map((entry) => entry.path);
  if (paths.length === 0) throw new ExecutionContractError("Effective Validation Base has an empty manifest");
  if (new Set(paths).size !== paths.length) throw new ExecutionContractError("Effective Validation Base has duplicate paths");
  if (paths.some((value, index) => index > 0 && value.localeCompare(paths[index - 1], "en") <= 0)) {
    throw new ExecutionContractError("Effective Validation Base paths are not lexicographically ordered");
  }
  const commandSection = section.slice(commandsMarker, evidenceMarker).trimEnd();
  const commandLines = commandSection.split("\n").slice(1).filter((line) => line.length !== 0);
  if (commandLines.length === 0 || commandLines.some((line) => !/^  - `[^`]+` \| exit:[-]?[0-9]+$/u.test(line))) {
    throw new ExecutionContractError("Effective Validation Base has malformed Authoritative commands");
  }
  const commandExits = [...commandSection.matchAll(/^  - `[^`]+` \| exit:([-]?[0-9]+)$/gmu)].map((match) => Number(match[1]));
  if (commandExits.length === 0 || commandExits.some((exit) => exit !== 0)) {
    throw new ExecutionContractError("Effective Validation Base authoritative commands must exist and exit zero");
  }
  requireNonPlaceholder(field(section, "Evidence summary"), "Effective Validation Base Evidence summary");
  return { present: true, paths, entries };
}

function finalState(section) {
  const result = section.match(/^- (pending|PASS|SUPERSEDED)$/mu)?.[1];
  if (result === undefined) throw new ExecutionContractError("Final Result is malformed");
  const supersededBy = result === "SUPERSEDED" ? field(section, "Superseded by") : null;
  const straySupersededBy = result === "SUPERSEDED" ? null : field(section, "Superseded by", { required: false });
  const strayPlanRevision = result === "SUPERSEDED" ? null : field(section, "Plan revision", { required: false });
  if (straySupersededBy !== null || strayPlanRevision !== null) throw new ExecutionContractError(`${result} Final Result contains supersession-only fields`);
  if (supersededBy !== null && !SLICE_FILE.test(`${supersededBy}.md`)) throw new ExecutionContractError("Final Result has malformed Superseded by slice");
  const planRevisionValue = result === "SUPERSEDED" ? field(section, "Plan revision") : null;
  if (planRevisionValue !== null && !/^[1-9][0-9]*$/u.test(planRevisionValue)) throw new ExecutionContractError("Final Result has malformed Plan revision");
  return { result, supersededBy, planRevision: planRevisionValue === null ? null : Number(planRevisionValue) };
}

function parseAttempts(section) {
  const attempts = operationRecords(section, "attempt", { statusValues: new Set(["PASS", "NEEDS_FIX", "BLOCKED"]) });
  if (attempts.length > 0 && field(attempts[0].body, "Type") !== "initial") throw new ExecutionContractError("attempt-01 must be initial");
  for (const attempt of attempts.slice(1)) if (field(attempt.body, "Type") !== "revalidation") throw new ExecutionContractError(`${attempt.id} must be revalidation`);
  for (const attempt of attempts) {
    for (const name of ["HEAD", "Verified scope", "Evidence", "Finding references", "Finding dispositions", "Blockers", "Unexpected workspace effects", "Persistence summary"]) {
      requirePresentValue(field(attempt.body, name), `${attempt.id} ${name}`);
    }
    requireCommands(attempt, { permitNone: attempt.status === "BLOCKED", requireZero: attempt.status === "PASS" });
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
  if (state === "resolved" && records.length <= priorIndex + 1) throw new ExecutionContractError("resolved Delegation Blocker requires a later valid record");
  return { operation, kind, state, afterRecord };
}

function validateFindingLifecycle(findings, attempts, findingsChecks) {
  const attemptsById = new Map(attempts.map((attempt, index) => [attempt.id, { ...attempt, index }]));
  for (const finding of findings) {
    const origin = attemptsById.get(finding.origin);
    if (origin === undefined || origin.status !== "NEEDS_FIX") throw new ExecutionContractError(`${finding.id} Origin must name an existing NEEDS_FIX attempt`);
    if (finding.state === "resolved") {
      const resolutionAttemptId = field(finding.body, "Resolution").match(/\battempt-[0-9]{2,}\b/u)?.[0];
      const resolution = attemptsById.get(resolutionAttemptId);
      if (resolution === undefined || resolution.index < origin.index || !new Set(["PASS", "NEEDS_FIX"]).has(resolution.status)) {
        throw new ExecutionContractError(`${finding.id} Resolution must name an existing current or later formal attempt`);
      }
    }
  }
  for (const check of findingsChecks) {
    const cycle = attemptsById.get(check.findingsCycle);
    if (cycle === undefined || cycle.status !== "NEEDS_FIX") throw new ExecutionContractError(`${check.id} Findings cycle must name an existing NEEDS_FIX attempt`);
    const latestApplicable = attempts.slice(0, cycle.index + 1).filter((attempt) => attempt.status === "NEEDS_FIX").at(-1);
    if (latestApplicable?.id !== check.findingsCycle) throw new ExecutionContractError(`${check.id} Findings cycle is not the latest applicable NEEDS_FIX attempt`);
  }
}

function changedPathClaims(section, label, sentinel) {
  if (section === sentinel) return [];
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
  const implementationChecks = parseChecks(taskSections.get("Implementation Test Evidence"), "implementation-check");
  const findingsChecks = parseChecks(taskSections.get("Findings Test Evidence"), "findings-check");
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
  const changedAreas = changedPathClaims(taskSections.get("Changed Areas"), `${label} Changed Areas`, "- pending");
  const corrections = changedPathClaims(taskSections.get("Corrections Applied"), `${label} Corrections Applied`, "- none");
  if (corrections.some((claim) => !changedAreas.includes(claim))) throw new ExecutionContractError(`${label} correction path is absent from Changed Areas`);
  const changedClaims = [...new Set([...changedAreas, ...corrections])];
  const checklist = taskSections.get("Checklist") ?? "";
  const checklistRows = [...checklist.matchAll(/^- \[([ x])\] [0-9]+\.[0-9]+\b/gmu)];
  if (checklistRows.length === 0) throw new ExecutionContractError(`${label} has no canonical checklist rows`);
  const checklistComplete = checklistRows.every((match) => match[1] === "x");
  if (attempts.length !== 0 && !checklistComplete) throw new ExecutionContractError(`${label} has Validation Attempts before the mandatory checklist is complete`);
  const pristine = [...PRISTINE].every(([name, sentinel]) => taskSections.get(name) === sentinel)
    && !/^- \[x\]/gmu.test(taskSections.get("Checklist") ?? "");
  const activeBlockers = [...findings, ...divergences].filter((record) => record.severity === "blocking" && record.state === "active");
  const activeBlockingDivergence = divergences.some((record) => record.severity === "blocking" && record.state === "active");
  for (const [name, latest] of [["implementation", implementationChecks.at(-1)], ["findings", findingsChecks.at(-1)]]) {
    const expectedOperation = name === "implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS";
    const pausedByDelegation = delegationBlocker?.state === "active" && delegationBlocker.operation === expectedOperation
      && delegationBlocker.afterRecord === latest?.id;
    if (latest?.status === "TESTS_FAIL" && latest.round < 3 && !activeBlockingDivergence && !pausedByDelegation) {
      throw new ExecutionContractError(`${label} has an unterminated ${name} automatic correction cycle without a blocking divergence`);
    }
  }
  if (attempts.at(-1)?.status === "NEEDS_FIX" && !findings.some((record) => record.severity === "blocking" && record.state === "active")) {
    throw new ExecutionContractError(`${label} latest NEEDS_FIX attempt has no active blocking finding`);
  }
  if (final.result === "PASS" && (!base.present || activeBlockers.length !== 0)) throw new ExecutionContractError(`${label} PASS retains no valid base or active blocker`);
  if (final.result === "PASS" && attempts.at(-1)?.status !== "PASS") throw new ExecutionContractError(`${label} PASS does not originate from its latest formal attempt`);
  if (attempts.at(-1)?.status === "PASS" && (final.result !== "PASS" || !base.present)) throw new ExecutionContractError(`${label} latest PASS attempt was not published atomically`);
  if (final.result === "SUPERSEDED" && base.present) throw new ExecutionContractError(`${label} SUPERSEDED must not retain an Effective Validation Base`);
  if (final.result === "PASS" && changedClaims.some((claim) => !base.paths.includes(claim))) {
    throw new ExecutionContractError(`${label} has a changed/corrected path with no validation owner`);
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
  return {
    ...state, body, sections: taskSections, pristine, attempts, findings, divergences, activeBlockers,
    base, final, implementationChecks, findingsChecks, delegationBlocker, retryExhausted, checklistComplete,
    changedClaims, claims: [...new Set([...changedClaims, ...base.paths])],
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

async function validateFinalOwnership(result) {
  const owners = new Map();
  const trustedRoot = await trustedProjectRoot(result.workspace);
  for (const row of result.rows) {
    if (row.result !== "PASS") continue;
    const task = result.tasks.get(row.slice);
    const taskDirectory = path.join(result.workspace.executionRoot, "tasks");
    for (const entry of task.base.entries) {
      const target = path.resolve(taskDirectory, entry.path);
      await rejectSymlinkComponents(target, trustedRoot);
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
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
      findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current absent/non-file)`);
      continue;
    }
    const actual = createHash("sha256").update(await fs.readFile(owner.target)).digest("hex");
    if (actual !== owner.hash) findings.push(`${owner.target} (${owner.slice}: expected sha256:${owner.hash}, current sha256:${actual})`);
  }
  if (findings.length !== 0) throw new ExecutionContractError("final validation ownership does not match the workspace", findings);
}

function parseGlobalRows(text) {
  const { header, body } = parsePurpose(text, "tasks.md");
  if (header.get("owner") !== "stnl-task-materializer" || header.get("status") !== "ready") {
    throw new ExecutionContractError("tasks.md has an invalid File Purpose Header owner or status");
  }
  if (!body.startsWith("# Execution Tasks\n\n") || /^## /gmu.test(body)) throw new ExecutionContractError("tasks.md has a non-canonical heading structure");
  const rows = [];
  for (const line of body.split("\n")) {
    if (!/^\| \[[ x]\] \|/u.test(line)) continue;
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length !== 7) throw new ExecutionContractError(`tasks.md has malformed row: ${line}`);
    const sliceMatch = columns[1].match(/^([0-9]{2,}) - \S.*$/u);
    if (sliceMatch === null || columns[4] !== `tasks/slice-${sliceMatch[1]}.md`) throw new ExecutionContractError(`tasks.md has malformed slice mapping: ${line}`);
    rows.push({ done: columns[0] === "[x]", slice: `slice-${sliceMatch[1]}`, validation: columns[5], result: columns[6] });
  }
  if (rows.length === 0) throw new ExecutionContractError("tasks.md has no slice rows");
  if (new Set(rows.map((row) => row.slice)).size !== rows.length) throw new ExecutionContractError("tasks.md has duplicate slice rows");
  return rows;
}

function requirementsReference(workspace, directory) {
  return path.relative(directory, workspace.authorityPath).split(path.sep).join("/");
}

async function readPlanArtifacts(workspace) {
  const globalPlanPath = path.join(workspace.executionRoot, "plan.md");
  await requireRealFile(globalPlanPath, "execution plan.md");
  const globalPlanText = await fs.readFile(globalPlanPath, "utf8");
  const globalPlan = parsePlan(globalPlanText, "plan.md", null, {
    requirementsSource: requirementsReference(workspace, workspace.executionRoot),
  });
  const serialOrder = globalPlan.sections.get("Serial Slice Order");
  const planLinks = [...serialOrder.matchAll(/\| plans\/(slice-[0-9]{2,})\.md \|$/gmu)].map((match) => match[1]);
  const sliceOrder = [...new Set(planLinks)];
  if (sliceOrder.length === 0 || sliceOrder.length !== planLinks.length) throw new ExecutionContractError("plan.md has missing or duplicate detailed plan mappings");
  const plans = new Map();
  const planDirectory = path.join(workspace.executionRoot, "plans");
  for (const slice of sliceOrder) {
    const detailedPath = path.join(planDirectory, `${slice}.md`);
    await requireRealFile(detailedPath, `${slice} detailed plan`);
    plans.set(slice, parsePlan(await fs.readFile(detailedPath, "utf8"), `${slice} plan`, slice, {
      requirementsSource: requirementsReference(workspace, planDirectory),
    }));
  }
  return { globalPlan, globalPlanText, sliceOrder, plans };
}

async function executionArtifacts(workspace) {
  const { globalPlan, sliceOrder, plans } = await readPlanArtifacts(workspace);
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
    const task = parseTask(await fs.readFile(taskPath, "utf8"), `${row.slice} task`, row.slice, {
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
  const trustedRoot = await trustedProjectRoot(workspace);
  const taskDirectory = path.join(workspace.executionRoot, "tasks");
  for (const [slice, task] of tasks) {
    for (const claim of task.claims) {
      await rejectSymlinkComponents(path.resolve(taskDirectory, claim), trustedRoot).catch((error) => {
        throw new ExecutionContractError(`${slice} contains an unsafe validation-owned path: ${claim}`, error.findings ?? []);
      });
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
  const workspace = await resolveExecutionWorkspace(specPath);
  const currentFingerprint = await computeRequirementsAuthority(specPath);
  const rootMetadata = await lstatOrNull(workspace.executionRoot);
  if (rootMetadata === null) return { state: "EMPTY", workspace, currentFingerprint };
  const nonIgnored = (await fs.readdir(workspace.executionRoot, { withFileTypes: true })).filter((entry) => !isIgnoredMetadata(entry.name));
  if (nonIgnored.length === 0) return { state: "EMPTY", workspace, currentFingerprint };
  const hasTasks = await lstatOrNull(path.join(workspace.executionRoot, "tasks.md")) !== null;
  await validateExecutionLayout(specPath, { allowPlanned: !hasTasks });
  if (!hasTasks) {
    const { globalPlan, plans } = await readPlanArtifacts(workspace);
    if (globalPlan.revisionMode === null && globalPlan.revision !== 1) throw new ExecutionContractError("initial plan must use Plan revision 1");
    if (globalPlan.revisionMode !== null) throw new ExecutionContractError("REPLAN cannot exist without materialized historical tasks");
    if ([...plans.values()].some((plan) => plan.fingerprint !== globalPlan.fingerprint || plan.revision !== globalPlan.revision)) {
      throw new ExecutionContractError("detailed plans do not match the global planning authority and revision");
    }
    if (globalPlan.status === "ready" && [...plans.values()].some((plan) => plan.status !== "ready")) {
      throw new ExecutionContractError("ready global plan retains a draft detailed plan");
    }
    const stale = globalPlan.fingerprint !== currentFingerprint;
    const state = stale ? "REQUIREMENTS_CHANGED" : globalPlan.status === "ready" ? "PLANNED_READY" : "PLANNED_DRAFT";
    return { state, workspace, currentFingerprint, globalPlan, stale };
  }
  const artifacts = await executionArtifacts(workspace);
  const stale = artifacts.globalPlan.fingerprint !== currentFingerprint;
  const allPristine = artifacts.rows.every((row) => !row.done && artifacts.tasks.get(row.slice).pristine);
  if (artifacts.pendingReplan) {
    if (artifacts.globalPlan.fingerprint !== currentFingerprint) throw new ExecutionContractError("pending REPLAN fingerprint is stale relative to current requirements authority");
    const state = artifacts.globalPlan.status === "ready" ? "PENDING_REPLAN_READY" : "PENDING_REPLAN_DRAFT";
    return { state, workspace, currentFingerprint, stale: false, ...artifacts };
  }
  const effectiveSlices = artifacts.rows.filter((row) => row.result !== "SUPERSEDED").map((row) => row.slice);
  const activeFindings = effectiveSlices.flatMap((slice) => artifacts.tasks.get(slice).findings.filter((record) => record.severity === "blocking" && record.state === "active").map((record) => `${slice}:${record.id}`));
  const activeDivergences = effectiveSlices.flatMap((slice) => artifacts.tasks.get(slice).divergences.filter((record) => record.severity === "blocking" && record.state === "active").map((record) => `${slice}:${record.id}`));
  const activeDelegationBlockers = effectiveSlices.flatMap((slice) => {
    const blocker = artifacts.tasks.get(slice).delegationBlocker;
    return blocker?.state === "active" ? [{ slice, ...blocker }] : [];
  });
  if (activeDelegationBlockers.length > 1) throw new ExecutionContractError("multiple active Delegation Blockers make resume ambiguous");
  const exhausted = effectiveSlices.map((slice) => [slice, artifacts.tasks.get(slice).retryExhausted]).filter(([, value]) => value !== null);
  const validationBlocked = effectiveSlices.filter((slice) => artifacts.tasks.get(slice).attempts.at(-1)?.status === "BLOCKED");
  const auxiliaryBlocked = effectiveSlices.flatMap((slice) => {
    const task = artifacts.tasks.get(slice);
    const latestAttempt = task.attempts.at(-1);
    const implementation = task.implementationChecks.at(-1);
    const findings = task.findingsChecks.at(-1);
    if (latestAttempt === undefined && implementation?.status === "BLOCKED") return [{ slice, operation: "EXECUTE_SLICE", record: implementation.id }];
    if (latestAttempt?.status === "NEEDS_FIX" && findings?.status === "BLOCKED" && findings.findingsCycle === latestAttempt.id) {
      return [{ slice, operation: "APPLY_FINDINGS", record: findings.id }];
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
  return {
    state, workspace, currentFingerprint, stale, activeFindings, activeDivergences, activeDelegationBlockers,
    exhausted, auxiliaryBlocked, findingsCorrected, implementedAwaitingValidation, validationBlocked, ...artifacts,
  };
}

export async function preflightExecutionOperation(specPath, operation, sliceValue = null) {
  const normalizedOperation = String(operation);
  if (!OPERATIONS.has(normalizedOperation)) throw new ExecutionContractError(`unsupported operation ${normalizedOperation}`);
  const needsSlice = SLICE_OPERATIONS.has(normalizedOperation);
  if (needsSlice !== (sliceValue !== null && sliceValue !== undefined)) throw new ExecutionContractError(`${normalizedOperation} ${needsSlice ? "requires" : "does not accept"} SLICE`);
  let slice = null;
  if (needsSlice) {
    const raw = String(sliceValue);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new ExecutionContractError("SLICE must be one unsigned decimal number without prefix");
    slice = `slice-${raw.padStart(2, "0")}`;
  }
  const result = await inspectExecutionState(specPath);
  const allowed = {
    PLAN: new Set(["EMPTY"]),
    REVIEW_PLAN: new Set(["PLANNED_DRAFT", "PLANNED_READY", "PENDING_REPLAN_DRAFT", "PENDING_REPLAN_READY"]),
    MATERIALIZE_TASKS: new Set(["PLANNED_READY", "PENDING_REPLAN_READY"]),
    REVIEW_TASKS: new Set(["MATERIALIZED_PRISTINE"]),
    REPLAN: new Set(["PLANNED_DRAFT", "PLANNED_READY", "MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "REQUIREMENTS_CHANGED", "DIVERGENCE_BLOCKED", "VALIDATION_BLOCKED", "IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "REPLAN_REQUIRED", "COMPLETE"]),
    EXECUTE_SLICE: new Set(["MATERIALIZED_PRISTINE", "EXECUTION_STARTED", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"]),
    APPLY_FINDINGS: new Set(["VALIDATION_NEEDS_FIX", "AUXILIARY_BLOCKED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"]),
    VALIDATE_SLICE: new Set(["IMPLEMENTED_AWAITING_VALIDATION", "FINDINGS_CORRECTED", "VALIDATION_BLOCKED", "IMPLEMENTATION_RETRY_EXHAUSTED", "FINDINGS_RETRY_EXHAUSTED", "RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"]),
    CLOSE: new Set(["COMPLETE"]),
  }[normalizedOperation];
  if (!allowed.has(result.state)) {
    const recoveries = RECOVERY_OPERATIONS.get(result.state) ?? [];
    const suffix = recoveries.length === 0 ? "" : `; legal next operation${recoveries.length === 1 ? " is" : "s are"} ${recoveries.join(" or ")}`;
    throw new ExecutionContractError(`${normalizedOperation} is not legal from ${result.state}${suffix}`);
  }
  if (slice !== null && !result.tasks?.has(slice)) throw new ExecutionContractError(`${slice} is absent from the execution artifacts`);
  if (slice !== null) {
    const selectedRow = result.rows.find((row) => row.slice === slice);
    const selectedTask = result.tasks.get(slice);
    if (selectedRow.done || selectedTask.final.result !== "pending") throw new ExecutionContractError(`${slice} is terminal and immutable`);
    const selectedIndex = result.rows.indexOf(selectedRow);
    if (result.rows.slice(0, selectedIndex).some((row) => !row.done)) throw new ExecutionContractError(`${slice} has an incomplete serial dependency`);
    if (normalizedOperation === "EXECUTE_SLICE") {
      if (selectedTask.attempts.length !== 0) throw new ExecutionContractError(`${slice} already has formal validation history; EXECUTE_SLICE cannot re-enter`);
    }
    if (normalizedOperation === "VALIDATE_SLICE" && !selectedTask.checklistComplete) throw new ExecutionContractError(`${slice} checklist is incomplete`);
  }
  if (new Set(["RUNNER_INITIALIZATION_BLOCKED", "RUNNER_RESULT_BLOCKED"]).has(result.state)) {
    const blocker = result.activeDelegationBlockers[0];
    if (blocker.slice !== slice || blocker.operation !== normalizedOperation) {
      throw new ExecutionContractError(`${result.state} may resume only ${blocker.operation} for ${blocker.slice}`);
    }
  }
  if (result.state === "AUXILIARY_BLOCKED") {
    const blocker = result.auxiliaryBlocked[0];
    if (blocker.slice !== slice || blocker.operation !== normalizedOperation) {
      throw new ExecutionContractError(`AUXILIARY_BLOCKED may resume only ${blocker.operation} for ${blocker.slice}`);
    }
  }
  if (normalizedOperation === "APPLY_FINDINGS" && !result.tasks.get(slice).findings.some((record) => record.severity === "blocking" && record.state === "active")) {
    throw new ExecutionContractError(`${slice} has no active blocking finding`);
  }
  if (normalizedOperation === "CLOSE") await validateFinalOwnership(result);
  return { ...result, operation: normalizedOperation, slice };
}
