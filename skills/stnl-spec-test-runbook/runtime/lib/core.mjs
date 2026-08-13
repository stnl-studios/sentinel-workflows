import * as fs from "node:fs/promises";
import path from "node:path";
import { computeRequirementsAuthority, inspectExecutionState } from "../execution-state.mjs";

const SCOPES = new Set(["TASK", "SLICE", "MULTI_SLICE", "EXECUTION", "SPEC", "CUSTOM"]);
const SLICE_FILE = /^slice-[0-9]{2,}\.md$/u;
const TASK_LABEL = /^[0-9]+\.[0-9]+$/u;
const EXECUTION_ROOT_FILES = new Set(["plan.md", "tasks.md"]);
const EXECUTION_ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SECRET_PATH_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", "credentials", "credentials.json", "id_rsa", "id_ed25519",
  "cookies", "cookies.json", "secrets", "secrets.json",
]);
const PURPOSE_HEADER_FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"];
const ACTIVE_FEATURE_SECTIONS = [
  "Objective", "Context", "Scope", "Out of Scope", "Requirements", "Business Rules", "Relevant Contracts",
  "Canonical Artifact Index", "Blockers", "Selective Reading",
];
const CLOSED_FEATURE_SECTION_ORDER = [
  "Objective", "Context", "Final Scope", "Out of Scope", "Requirements", "Business Rules", "Final Acceptance Criteria",
  "Durable Decisions", "Relevant Constraints", "Relevant Risks", "Important Contracts", "Durable Resolved Questions",
];
const REQUIRED_CLOSED_FEATURE_SECTIONS = [
  "Objective", "Context", "Final Scope", "Out of Scope", "Requirements", "Business Rules", "Important Contracts",
];
const CANONICAL_ARTIFACTS = new Map([
  ["requirements", "shared/requirements.md"],
  ["acceptance_criteria", "shared/acceptance-criteria.md"],
  ["decisions", "shared/decisions.md"],
  ["constraints", "shared/constraints.md"],
  ["risks", "shared/risks.md"],
  ["questions", "shared/questions.md"],
]);
const SHARED_CATEGORIES = new Map([
  ["shared/requirements.md", { heading: "Requirements", prefix: "R", fields: ["status", "retired_reason", "coverage_justification", "references"], required: ["status"], statuses: ["in_scope", "out_of_scope", "superseded", "retired"], sections: [] }],
  ["shared/acceptance-criteria.md", { heading: "Acceptance Criteria", prefix: "AC", fields: ["status", "retired_reason", "verifies", "blocked_by", "references"], required: ["status", "verifies"], statuses: ["active", "superseded", "dropped", "retired"], sections: [] }],
  ["shared/decisions.md", { heading: "Decisions", prefix: "D", fields: ["status", "retired_reason", "references"], required: ["status"], statuses: ["accepted", "superseded", "retired"], sections: ["Contexto", "Decisão", "Impacto"] }],
  ["shared/constraints.md", { heading: "Constraints", prefix: "C", fields: ["status", "retired_reason", "references"], required: ["status"], statuses: ["active", "retired"], sections: ["Restrição", "Razão"] }],
  ["shared/risks.md", { heading: "Risks", prefix: "RK", fields: ["status", "retired_reason", "impact", "references"], required: ["status", "impact"], statuses: ["active", "retired"], sections: ["Risco", "Mitigação"] }],
  ["shared/questions.md", { heading: "Questions", prefix: "Q", fields: ["status", "classification", "blocks", "resolved_by", "linked_decision", "references"], required: ["status", "classification"], statuses: ["open", "resolved", "bypassed", "dropped"], sections: ["Pergunta", "Por que importa", "Resolução"] }],
]);
const CLOSED_CATEGORY_PATHS = new Map([
  ["Requirements", "shared/requirements.md"],
  ["Final Acceptance Criteria", "shared/acceptance-criteria.md"],
  ["Durable Decisions", "shared/decisions.md"],
  ["Relevant Constraints", "shared/constraints.md"],
  ["Relevant Risks", "shared/risks.md"],
  ["Durable Resolved Questions", "shared/questions.md"],
]);
const PLAN_SECTIONS = ["Global Context", "Serial Slice Order", "Global Risks and Integration"];
const SLICE_PLAN_SECTIONS = [
  "References", "Objective and Observable Result", "Requirements", "Included Scope", "Out of Scope and Boundaries",
  "Likely Areas", "Dependencies", "Risks and Strategy", "Expected Tests", "Completion Criterion",
];
const SLICE_TASK_SECTIONS = [
  "References", "Checklist", "Expected Tests", "Changed Areas", "Scope Expansion", "Prior Validation Overlap", "Divergences",
  "Delegation Blocker", "Implementation Test Evidence", "Findings Test Evidence", "Validation Attempts", "Validation Findings", "Corrections Applied",
  "Effective Validation Base", "Diff Summary", "Final Result",
];

export function isIgnoredMetadata(name) {
  return name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._");
}

export async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function assertNoSymlinkComponents(filePath, label) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatOrNull(current);
    if (metadata === null) break;
    if (metadata.isSymbolicLink()) {
      const allowedDarwinAlias = process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(current);
      if (!allowedDarwinAlias) throw new Error(`${label} contains a symlink component: ${current}`);
    }
  }
}

async function requireRealFile(filePath, label) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link real file: ${filePath}`);
  }
  return filePath;
}

async function requireRealDirectory(filePath, label) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${filePath}`);
  }
  return filePath;
}

async function readBoundedText(filePath, label) {
  const metadata = await fs.stat(filePath);
  if (metadata.size > 2_000_000) throw new Error(`${label} exceeds the 2 MB safety limit: ${filePath}`);
  return fs.readFile(filePath, "utf8");
}

function parsePurposeHeader(text, label) {
  const match = text.match(/^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n\n/u);
  if (match === null) throw new Error(`${label} is missing the normalized File Purpose Header`);
  const lines = match[1].split("\n").filter((line) => line.length !== 0);
  const keys = [];
  const values = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${label} has a malformed File Purpose Header`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (Object.hasOwn(values, key) || value.length === 0) throw new Error(`${label} has an invalid File Purpose Header field: ${key}`);
    keys.push(key);
    values[key] = value;
  }
  if (keys.length !== PURPOSE_HEADER_FIELDS.length || keys.some((key, index) => key !== PURPOSE_HEADER_FIELDS[index])) {
    throw new Error(`${label} has non-canonical File Purpose Header fields`);
  }
  return { values, body: text.slice(match[0].length) };
}

function requireHeadingContract(body, h1Pattern, sections, label) {
  const headings = [...body.matchAll(/^#{1,2} (.+)$/gmu)].map((match) => ({ level: match[0].startsWith("## ") ? 2 : 1, title: match[1] }));
  if (headings.length === 0 || headings[0].level !== 1 || !h1Pattern.test(headings[0].title)) {
    throw new Error(`${label} has a non-canonical primary heading`);
  }
  const actualSections = headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
  if (actualSections.length !== sections.length || actualSections.some((heading, index) => heading !== sections[index])) {
    throw new Error(`${label} has non-canonical sections`);
  }
}

function requireClosedHeadingContract(body) {
  const headings = [...body.matchAll(/^#{1,2} (.+)$/gmu)].map((match) => ({ level: match[0].startsWith("## ") ? 2 : 1, title: match[1] }));
  if (headings.length === 0 || headings[0].level !== 1 || !/^.+ - Feature SPEC$/u.test(headings[0].title)) {
    throw new Error("closed feature_spec.md has a non-canonical primary heading");
  }
  const sections = headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
  if (new Set(sections).size !== sections.length || sections.some((heading) => !CLOSED_FEATURE_SECTION_ORDER.includes(heading))) {
    throw new Error("closed feature_spec.md has non-canonical sections");
  }
  if (REQUIRED_CLOSED_FEATURE_SECTIONS.some((heading) => !sections.includes(heading))) {
    throw new Error("closed feature_spec.md is missing a required section");
  }
  if (sections.some((heading, index) => index > 0
    && CLOSED_FEATURE_SECTION_ORDER.indexOf(heading) < CLOSED_FEATURE_SECTION_ORDER.indexOf(sections[index - 1]))) {
    throw new Error("closed feature_spec.md sections are out of order");
  }
}

function sectionBody(body, heading) {
  const marker = `## ${heading}\n`;
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const contentStart = start + marker.length;
  const next = body.indexOf("\n## ", contentStart);
  return body.slice(contentStart, next < 0 ? body.length : next).trim();
}

function executionAuthority(body, heading, label) {
  const authoritySection = sectionBody(body, heading);
  if (authoritySection === null) throw new Error(`${label} is missing its ${heading} authority section`);
  const authorities = [...authoritySection.matchAll(/^- Requirements authority: sha256:([0-9a-f]{64})$/gmu)];
  const revisions = [...authoritySection.matchAll(/^- Plan revision: ([1-9][0-9]*)$/gmu)];
  if (authorities.length !== 1) throw new Error(`${label} must contain exactly one canonical Requirements authority`);
  if (revisions.length !== 1) throw new Error(`${label} must contain exactly one canonical Plan revision`);
  return { fingerprint: authorities[0][1], revision: Number(revisions[0][1]) };
}

function artifactIndexPaths(body, label) {
  const match = body.match(/\n## Canonical Artifact Index\n\n```yaml\n([\s\S]*?)```\n/u);
  if (match === null) throw new Error(`${label} has no canonical artifact index block`);
  const lines = match[1].split("\n").filter(Boolean);
  if (lines.length === 1 && lines[0] === "artifacts: {}") return [];
  if (lines[0] !== "artifacts:") throw new Error(`${label} has a malformed canonical artifact index`);
  const entries = lines.slice(1).map((line) => {
    const entry = line.match(/^  ([a-z_]+): (shared\/[a-z-]+\.md)$/u);
    if (entry === null) throw new Error(`${label} has a malformed canonical artifact index entry`);
    if (!CANONICAL_ARTIFACTS.has(entry[1]) || CANONICAL_ARTIFACTS.get(entry[1]) !== entry[2]) {
      throw new Error(`${label} has an unknown or mismatched canonical artifact category: ${entry[1]}`);
    }
    return { key: entry[1], path: entry[2] };
  });
  const keys = entries.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} has duplicate canonical artifact categories`);
  const canonicalKeys = [...CANONICAL_ARTIFACTS.keys()];
  if (keys.some((key, index) => index > 0 && canonicalKeys.indexOf(key) < canonicalKeys.indexOf(keys[index - 1]))) {
    throw new Error(`${label} canonical artifact categories are out of order`);
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error(`${label} has duplicate canonical artifact index paths`);
  return paths;
}

function validateSharedBody(body, relative) {
  const category = SHARED_CATEGORIES.get(relative);
  if (category === undefined) throw new Error(`${relative} is not a canonical shared category`);
  if (!body.startsWith(`# ${category.heading}\n\n`)) throw new Error(`${relative} has a non-canonical category heading`);
  if (/^## /gmu.test(body) || /^# (?!#)/gmu.test(body.slice(`# ${category.heading}\n`.length))) {
    throw new Error(`${relative} has a non-canonical category layout`);
  }
  if (/^```(?:yaml|yml)\s*$/gimu.test(body)) throw new Error(`${relative} contains YAML beyond its File Purpose Header`);
  const recordPattern = new RegExp(`^### (${category.prefix}-[0-9]{3}) — (\\S.*)$`, "gmu");
  const records = [...body.matchAll(recordPattern)];
  const allRecordHeadings = [...body.matchAll(/^### (.+)$/gmu)];
  if (records.length === 0 || records.length !== allRecordHeadings.length) {
    throw new Error(`${relative} has missing or malformed canonical record headings`);
  }
  const ids = records.map((record) => record[1]);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id < ids[index - 1])) {
    throw new Error(`${relative} has duplicate or unsorted canonical record IDs`);
  }
  const validated = [];
  for (let index = 0; index < records.length; index += 1) {
    const start = records[index].index + records[index][0].length;
    const end = index + 1 < records.length ? records[index + 1].index : body.length;
    const recordBody = body.slice(start, end).trim();
    const metadataBlock = recordBody.split("\n\n", 1)[0];
    const metadata = {};
    const metadataKeys = [];
    for (const line of metadataBlock.split("\n")) {
      const match = line.match(/^- ([a-z_]+): (.+)$/u);
      if (match === null || !category.fields.includes(match[1]) || Object.hasOwn(metadata, match[1])) {
        throw new Error(`${relative} record ${records[index][1]} has malformed, unknown, or duplicate metadata`);
      }
      metadataKeys.push(match[1]);
      metadata[match[1]] = match[2];
    }
    if (metadataKeys.some((key, position) => position > 0
      && category.fields.indexOf(key) < category.fields.indexOf(metadataKeys[position - 1]))) {
      throw new Error(`${relative} record ${records[index][1]} metadata is out of order`);
    }
    const missing = category.required.filter((field) => !Object.hasOwn(metadata, field));
    if (missing.length !== 0) throw new Error(`${relative} record ${records[index][1]} is missing required metadata: ${missing.join(", ")}`);
    const status = metadata.status;
    if (status === undefined || !category.statuses.includes(status)) {
      throw new Error(`${relative} record ${records[index][1]} has a missing or invalid canonical status`);
    }
    if ((status === "retired") !== Object.hasOwn(metadata, "retired_reason")) {
      throw new Error(`${relative} record ${records[index][1]} has inconsistent retirement metadata`);
    }
    if (category.prefix === "AC" && !/^\[(?:R-[0-9]{3})(?:, R-[0-9]{3})*\]$/u.test(metadata.verifies)) {
      throw new Error(`${relative} record ${records[index][1]} has malformed verifies metadata`);
    }
    if (category.prefix === "RK" && !["low", "medium", "high"].includes(metadata.impact)) {
      throw new Error(`${relative} record ${records[index][1]} has invalid impact metadata`);
    }
    if (category.prefix === "Q") {
      if (!["blocking", "non_blocking", "irrelevant"].includes(metadata.classification)) {
        throw new Error(`${relative} record ${records[index][1]} has invalid classification metadata`);
      }
      if (status === "open" && metadata.classification === "blocking" && metadata.blocks === undefined) {
        throw new Error(`${relative} record ${records[index][1]} is an open blocking question without blocks metadata`);
      }
      if (status !== "open" && metadata.resolved_by === undefined) {
        throw new Error(`${relative} record ${records[index][1]} has no final resolution authority`);
      }
    }
    const subsections = [...recordBody.matchAll(/^#### (.+)$/gmu)].map((match) => match[1]);
    if (subsections.length !== category.sections.length || subsections.some((heading, position) => heading !== category.sections[position])) {
      throw new Error(`${relative} record ${records[index][1]} has non-canonical subsections`);
    }
    validated.push({ id: records[index][1], metadata, relative });
  }
  return validated;
}

function metadataReferences(value, label) {
  if (value === undefined) return [];
  if (value === "[]") return [];
  const match = value.match(/^\[((?:AC|RK|R|D|C|Q)-[0-9]{3}(?:, (?:AC|RK|R|D|C|Q)-[0-9]{3})*)\]$/u);
  if (match === null) throw new Error(`${label} has malformed canonical ID array metadata`);
  return match[1].split(", ");
}

function validateRecordReferenceIntegrity(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    for (const field of ["references", "verifies", "blocked_by", "blocks"]) {
      for (const reference of metadataReferences(record.metadata[field], `${record.relative} ${record.id}.${field}`)) {
        if (!byId.has(reference)) throw new Error(`${record.relative} record ${record.id} references missing canonical ID ${reference}`);
      }
    }
    if (record.metadata.linked_decision !== undefined && !byId.has(record.metadata.linked_decision)) {
      throw new Error(`${record.relative} record ${record.id} links a missing decision ${record.metadata.linked_decision}`);
    }
    if (record.id.startsWith("AC-") && record.metadata.status === "active") {
      for (const requirement of metadataReferences(record.metadata.verifies, `${record.relative} ${record.id}.verifies`)) {
        if (byId.get(requirement)?.metadata.status !== "in_scope") {
          throw new Error(`${record.relative} record ${record.id} does not verify an in-scope requirement: ${requirement}`);
        }
      }
    }
  }
}

function validateRecordRelationships(records, featureBody, sharedStatuses, featureStatus) {
  validateRecordReferenceIntegrity(records);
  const inScope = records.filter((record) => record.id.startsWith("R-") && record.metadata.status === "in_scope");
  const activeCriteria = records.filter((record) => record.id.startsWith("AC-") && record.metadata.status === "active");
  if (featureStatus === "ready") {
    if (inScope.length === 0 || activeCriteria.length === 0) throw new Error("ready feature_spec.md requires in-scope requirements and active acceptance criteria");
    if (activeCriteria.some((record) => record.metadata.blocked_by !== undefined)) {
      throw new Error("ready feature_spec.md cannot retain blocked_by acceptance criteria");
    }
    const covered = new Set(activeCriteria.flatMap((record) => metadataReferences(record.metadata.verifies, `${record.relative} ${record.id}.verifies`)));
    if (inScope.some((record) => !covered.has(record.id) && record.metadata.coverage_justification === undefined)) {
      throw new Error("ready feature_spec.md has an in-scope requirement without active acceptance coverage or justification");
    }
  }
  const requirementSection = sectionBody(featureBody, "Requirements");
  const listedRequirements = requirementSection === "- Not established."
    ? []
    : requirementSection?.split("\n").filter(Boolean).map((line) => line.match(/^- (R-[0-9]{3})$/u)?.[1]) ?? [];
  const actualRequirements = records.filter((record) => record.id.startsWith("R-")).map((record) => record.id).sort();
  if (requirementSection === "- Not established." && actualRequirements.length !== 0) {
    throw new Error("feature_spec.md uses the requirements sentinel despite canonical requirement records");
  }
  if (listedRequirements.some((item) => item === undefined)
    || listedRequirements.length !== actualRequirements.length
    || listedRequirements.some((item, index) => item !== actualRequirements[index])) {
    throw new Error("feature_spec.md Requirements does not exactly derive from canonical requirement records");
  }
  const openBlocking = records.filter((record) => record.id.startsWith("Q-")
    && record.metadata.status === "open" && record.metadata.classification === "blocking").map((record) => record.id).sort();
  const blockersAuthority = sectionBody(featureBody, "Blockers");
  const blockersMatch = blockersAuthority?.match(/^```yaml\nblocking_questions: \[([^\]]*)\]\ndocumentary_gaps: ([\s\S]+)\n```$/u);
  if (blockersMatch === undefined || blockersMatch === null) throw new Error("feature_spec.md has a malformed Blockers authority block");
  const blockers = blockersMatch[1];
  const listedBlocking = blockers.length === 0 ? [] : blockers.split(", ");
  if (listedBlocking.length !== openBlocking.length || listedBlocking.some((item, index) => item !== openBlocking[index])) {
    throw new Error("feature_spec.md blocking_questions does not exactly match open blocking questions");
  }
  if (sharedStatuses.has("shared/questions.md")) {
    const expected = openBlocking.length === 0 ? "ready" : "blocked";
    if (sharedStatuses.get("shared/questions.md") !== expected) {
      throw new Error(`shared/questions.md File Purpose Header status must be ${expected}`);
    }
  }
  const gapsBlock = blockersMatch[2];
  if (gapsBlock !== "[]" && !/^(?:\n  - \S.*)+$/u.test(gapsBlock)) {
    throw new Error("feature_spec.md has a malformed documentary_gaps authority");
  }
  const blockersPresent = openBlocking.length !== 0 || gapsBlock !== "[]";
  if (featureStatus === "ready" && blockersPresent) throw new Error("ready feature_spec.md cannot retain documentary blockers");
  if (featureStatus === "blocked" && !blockersPresent) throw new Error("blocked feature_spec.md requires a documentary blocker");
  if (openBlocking.length !== 0 && featureStatus !== "blocked") throw new Error("open blocking questions require blocked feature_spec.md status");
}

async function validateModularAuthority(workspace) {
  if (workspace.specRoot === null) return;
  const text = await readBoundedText(workspace.authorityPath, "feature_spec.md");
  const header = parsePurposeHeader(text, "feature_spec.md");
  if (header.values.owner !== "stnl-spec-lifecycle-manager") throw new Error("feature_spec.md has the wrong File Purpose Header owner");
  if (!["draft", "blocked", "ready", "closed"].includes(header.values.status)) {
    throw new Error(`feature_spec.md has an invalid documentary status: ${header.values.status}`);
  }
  const shared = path.join(workspace.specRoot, "shared");
  const sharedMetadata = await lstatOrNull(shared);
  if (header.values.status === "closed") {
    requireClosedHeadingContract(header.body);
    if (sharedMetadata !== null) throw new Error("closed feature_spec.md retains a shared authority directory");
    if (/^## (?:Canonical Artifact Index|Blockers|Selective Reading)$/gmu.test(header.body)) {
      throw new Error("closed feature_spec.md retains active-only sections");
    }
    if (/^```(?:yaml|yml)\s*$/gimu.test(header.body)) throw new Error("closed feature_spec.md contains YAML beyond its File Purpose Header");
    const closedRecords = [];
    for (const [heading, relative] of CLOSED_CATEGORY_PATHS) {
      const content = sectionBody(header.body, heading);
      if (content !== null) closedRecords.push(...validateSharedBody(`# ${SHARED_CATEGORIES.get(relative).heading}\n\n${content}\n`, relative));
    }
    validateRecordReferenceIntegrity(closedRecords);
    const allowedContextHeadings = new Set(["Facts", "Hypotheses"]);
    for (const match of header.body.matchAll(/^### (.+)$/gmu)) {
      const before = header.body.slice(0, match.index);
      const owner = [...before.matchAll(/^## (.+)$/gmu)].at(-1)?.[1];
      if (!CLOSED_CATEGORY_PATHS.has(owner) && !(owner === "Context" && allowedContextHeadings.has(match[1]))) {
        throw new Error(`closed feature_spec.md has a non-canonical level-3 heading: ${match[1]}`);
      }
    }
    return;
  }
  requireHeadingContract(header.body, /^.+ - Feature SPEC$/u, ACTIVE_FEATURE_SECTIONS, "feature_spec.md");
  const indexed = artifactIndexPaths(header.body, "feature_spec.md");
  const actual = (await canonicalSharedSources(workspace)).map((filePath) => path.relative(workspace.specRoot, filePath).split(path.sep).join("/"));
  if (indexed.length !== actual.length || [...indexed].sort().some((value, index) => value !== [...actual].sort()[index])) {
    throw new Error("feature_spec.md canonical artifact index does not exactly match shared authority files");
  }
  const records = [];
  const sharedStatuses = new Map();
  for (const relative of indexed) {
    const sharedText = await readBoundedText(path.join(workspace.specRoot, ...relative.split("/")), relative);
    const sharedHeader = parsePurposeHeader(sharedText, relative);
    const allowedStatuses = relative === "shared/questions.md" ? ["ready", "blocked"] : ["ready"];
    if (sharedHeader.values.owner !== "stnl-spec-lifecycle-manager" || !allowedStatuses.includes(sharedHeader.values.status)) {
      throw new Error(`${relative} has a non-canonical File Purpose Header owner or status`);
    }
    sharedStatuses.set(relative, sharedHeader.values.status);
    records.push(...validateSharedBody(sharedHeader.body, relative));
  }
  validateRecordRelationships(records, header.body, sharedStatuses, header.values.status);
}

async function validateExecutionArtifact(filePath, kind, slice = null) {
  const label = path.basename(filePath);
  const text = await readBoundedText(filePath, label);
  const header = parsePurposeHeader(text, label);
  const plan = kind === "plan" || kind === "slice-plan";
  const expectedOwner = plan ? "stnl-execution-planner" : "stnl-task-materializer";
  if (header.values.owner !== expectedOwner || header.values.status !== "ready") {
    throw new Error(`${label} has a non-canonical File Purpose Header owner or status`);
  }
  if (kind === "plan") {
    requireHeadingContract(header.body, /^Execution Plan$/u, PLAN_SECTIONS, label);
    if (!/^- Review state: approved$/gmu.test(header.body)) throw new Error(`${label} is not an approved execution plan`);
    return executionAuthority(header.body, "Global Context", label);
  } else if (kind === "slice-plan") {
    const number = slice.slice("slice-".length);
    requireHeadingContract(header.body, new RegExp(`^Slice ${number} - .+$`, "u"), SLICE_PLAN_SECTIONS, label);
    if (!/^- Review state: approved$/gmu.test(header.body)) throw new Error(`${label} is not an approved slice plan`);
    return executionAuthority(header.body, "References", label);
  } else if (kind === "tasks") {
    requireHeadingContract(header.body, /^Execution Tasks$/u, [], label);
    return null;
  } else {
    const number = slice.slice("slice-".length);
    requireHeadingContract(header.body, new RegExp(`^Slice ${number} Tasks - .+$`, "u"), SLICE_TASK_SECTIONS, label);
    return executionAuthority(header.body, "References", label);
  }
}

async function findSourceRoot(start) {
  let current = start;
  while (true) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function parseStrictJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  return parsed;
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length !== 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

export function normalizeSlice(value, label = "slice") {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new Error(`${label} must be one unsigned decimal number without prefix`);
  }
  return `slice-${text.padStart(2, "0")}`;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || isIgnoredMetadata(segment))) {
    throw new Error(`${label} contains a forbidden path segment`);
  }
  if (segments.some((segment) => {
    const lower = segment.toLowerCase();
    return SECRET_PATH_NAMES.has(lower) || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key");
  })) throw new Error(`${label} identifies a secret-bearing path`);
  return segments.join("/");
}

export async function resolveWorkspace(specPath) {
  const requested = path.resolve(String(specPath));
  await assertNoSymlinkComponents(requested, "SPEC_PATH");
  const metadata = await lstatOrNull(requested);
  if (metadata === null || metadata.isSymbolicLink()) {
    throw new Error(`SPEC_PATH must exist and must not be a symlink: ${requested}`);
  }
  const physical = await fs.realpath(requested);
  safeRelativePath(path.basename(physical), "SPEC_PATH basename");
  if (metadata.isDirectory()) {
    const authorityPath = path.join(physical, "feature_spec.md");
    await requireRealFile(authorityPath, "workspace feature_spec.md");
    const sourceRoot = await findSourceRoot(physical);
    return {
      kind: "modular",
      authorityPath,
      specRoot: physical,
      baseRoot: physical,
      sourceRoot,
      executionRoot: path.join(physical, "execution"),
      outputRoot: path.join(physical, "test-runbook"),
    };
  }
  if (!metadata.isFile()) throw new Error(`SPEC_PATH must be a workspace directory or requirements file: ${requested}`);
  if (path.basename(physical) === "feature_spec.md") {
    const specRoot = path.dirname(physical);
    const sourceRoot = await findSourceRoot(specRoot);
    return {
      kind: "modular",
      authorityPath: physical,
      specRoot,
      baseRoot: specRoot,
      sourceRoot,
      executionRoot: path.join(specRoot, "execution"),
      outputRoot: path.join(specRoot, "test-runbook"),
    };
  }
  const parsed = path.parse(physical);
  const sourceRoot = await findSourceRoot(parsed.dir);
  return {
    kind: "standalone",
    authorityPath: physical,
    specRoot: null,
    baseRoot: parsed.dir,
    sourceRoot,
    executionRoot: path.join(parsed.dir, `${parsed.name}-execution`),
    outputRoot: path.join(parsed.dir, `${parsed.name}-test-runbook`),
  };
}

export function normalizeSelection(scope, rawSelection) {
  const selection = requirePlainObject(rawSelection, "RUNBOOK_SELECTION");
  if (scope === "SPEC" || scope === "EXECUTION") {
    requireExactKeys(selection, new Set(), "RUNBOOK_SELECTION");
    return {};
  }
  if (scope === "SLICE") {
    requireExactKeys(selection, new Set(["slice"]), "RUNBOOK_SELECTION");
    if (!("slice" in selection)) throw new Error("RUNBOOK_SELECTION.slice is required for SLICE");
    return { slice: normalizeSlice(selection.slice) };
  }
  if (scope === "TASK") {
    requireExactKeys(selection, new Set(["slice", "task"]), "RUNBOOK_SELECTION");
    if (!("slice" in selection) || !("task" in selection)) {
      throw new Error("RUNBOOK_SELECTION.slice and task are required for TASK");
    }
    if (typeof selection.task !== "string" || !TASK_LABEL.test(selection.task)) {
      throw new Error("RUNBOOK_SELECTION.task must be an exact persisted numeric task label such as 1.1");
    }
    return { slice: normalizeSlice(selection.slice), task: selection.task };
  }
  if (scope === "MULTI_SLICE") {
    requireExactKeys(selection, new Set(["slices"]), "RUNBOOK_SELECTION");
    if (!Array.isArray(selection.slices) || selection.slices.length < 2) {
      throw new Error("RUNBOOK_SELECTION.slices must explicitly contain at least two slices for MULTI_SLICE");
    }
    const slices = selection.slices.map((value, index) => normalizeSlice(value, `slices[${index}]`));
    if (new Set(slices).size !== slices.length) throw new Error("RUNBOOK_SELECTION.slices contains duplicates");
    return { slices };
  }
  requireExactKeys(selection, new Set(["anchors", "paths"]), "RUNBOOK_SELECTION");
  if (!Array.isArray(selection.anchors) || selection.anchors.length === 0) {
    throw new Error("RUNBOOK_SELECTION.anchors must be a non-empty bounded array for CUSTOM");
  }
  const anchors = selection.anchors.map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`RUNBOOK_SELECTION.anchors[${index}] must be a non-empty string`);
    }
    return value.trim();
  });
  if (new Set(anchors).size !== anchors.length) throw new Error("RUNBOOK_SELECTION.anchors contains duplicates");
  if (selection.paths !== undefined && !Array.isArray(selection.paths)) {
    throw new Error("RUNBOOK_SELECTION.paths must be an array when provided");
  }
  const paths = selection.paths === undefined ? [] : selection.paths.map((value, index) =>
    safeRelativePath(value, `RUNBOOK_SELECTION.paths[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error("RUNBOOK_SELECTION.paths contains duplicates");
  return { anchors, paths };
}

async function canonicalSharedSources(workspace) {
  if (workspace.specRoot === null) return [];
  const shared = path.join(workspace.specRoot, "shared");
  const metadata = await lstatOrNull(shared);
  if (metadata === null) return [];
  await requireRealDirectory(shared, "shared authority");
  const sources = [];
  for (const entry of await fs.readdir(shared, { withFileTypes: true })) {
    if (isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(shared, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile() || path.extname(entry.name) !== ".md") {
      throw new Error(`shared authority contains a non-canonical entry: ${entryPath}`);
    }
    await requireRealFile(entryPath, "shared authority");
    sources.push(entryPath);
  }
  return sources.sort();
}

async function requireExecutionBase(workspace) {
  if (workspace.specRoot !== null) {
    const specFindings = [];
    // feature_spec.md/shared are lifecycle-owned. Every other SPEC-root sibling is
    // externally owned and must be preserved, not classified as execution residue.
    const output = path.join(workspace.specRoot, "test-runbook");
    const outputMetadata = await lstatOrNull(output);
    if (outputMetadata !== null && (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory())) specFindings.push(output);
    if (specFindings.length !== 0) throw new Error(`SPEC layout contains non-canonical paths: ${specFindings.sort().join(", ")}`);
  }
  await requireRealDirectory(workspace.executionRoot, "execution root");
  await assertNoSymlinkComponents(workspace.executionRoot, "execution root");
  const nonCanonical = [];
  for (const entry of await fs.readdir(workspace.executionRoot, { withFileTypes: true })) {
    if (isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(workspace.executionRoot, entry.name);
    if (EXECUTION_ROOT_FILES.has(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) nonCanonical.push(entryPath);
    } else if (EXECUTION_ROOT_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) nonCanonical.push(entryPath);
    } else nonCanonical.push(entryPath);
  }
  for (const directory of ["plans", "tasks"]) {
    const directoryPath = path.join(workspace.executionRoot, directory);
    const metadata = await lstatOrNull(directoryPath);
    if (metadata !== null && !metadata.isSymbolicLink() && metadata.isDirectory()) {
      for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
        if (isIgnoredMetadata(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink() || !SLICE_FILE.test(entry.name)) {
          nonCanonical.push(path.join(directoryPath, entry.name));
        }
      }
    }
  }
  const canonicalNames = async (directory) => (await fs.readdir(path.join(workspace.executionRoot, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && SLICE_FILE.test(entry.name))
    .map((entry) => entry.name).sort();
  const plans = await canonicalNames("plans");
  const tasks = await canonicalNames("tasks");
  for (const name of new Set([...plans, ...tasks])) {
    if (!plans.includes(name)) nonCanonical.push(path.join(workspace.executionRoot, "plans", name));
    if (!tasks.includes(name)) nonCanonical.push(path.join(workspace.executionRoot, "tasks", name));
  }
  if (nonCanonical.length !== 0) throw new Error(`execution layout contains non-canonical paths: ${[...new Set(nonCanonical)].sort().join(", ")}`);
  await requireRealDirectory(path.join(workspace.executionRoot, "plans"), "execution plans directory");
  await requireRealDirectory(path.join(workspace.executionRoot, "tasks"), "execution tasks directory");
  const sources = [
    await requireRealFile(path.join(workspace.executionRoot, "plan.md"), "execution plan"),
    await requireRealFile(path.join(workspace.executionRoot, "tasks.md"), "execution tasks"),
  ];
  const planAuthority = await validateExecutionArtifact(sources[0], "plan");
  const currentAuthority = await computeRequirementsAuthority(workspace.authorityPath);
  if (planAuthority.fingerprint !== currentAuthority) throw new Error("execution plan Requirements authority is stale relative to current requirements");
  await validateExecutionArtifact(sources[1], "tasks");
  return sources;
}

async function planSliceOrder(workspace) {
  const plan = await fs.readFile(path.join(workspace.executionRoot, "plan.md"), "utf8");
  const serial = sectionBody(plan, "Serial Slice Order");
  if (serial === null) throw new Error("execution plan has no canonical Serial Slice Order section");
  const order = [];
  const rows = serial.split("\n").filter((line) => /^\| (?!Slice |---)/u.test(line));
  for (const row of rows) {
    const columns = row.split("|").slice(1, -1).map((column) => column.trim());
    const match = columns.length === 6 ? columns[5].match(/^plans\/(slice-[0-9]{2,})\.md$/u) : null;
    if (match === null) throw new Error(`execution plan has a malformed serial slice row: ${row}`);
    if (order.includes(match[1])) throw new Error(`execution plan has a duplicate serial slice: ${match[1]}`);
    order.push(match[1]);
  }
  if (order.length === 0) throw new Error("execution plan does not declare a canonical serial slice order");
  return order;
}

async function taskSliceOrder(workspace) {
  const tasks = await fs.readFile(path.join(workspace.executionRoot, "tasks.md"), "utf8");
  const body = parsePurposeHeader(tasks, "tasks.md").body;
  const rows = body.split("\n").filter((line) => /^\| \[[ x]\] \|/u.test(line));
  const order = [];
  for (const row of rows) {
    const columns = row.split("|").slice(1, -1).map((column) => column.trim());
    const slice = columns.length === 7 ? columns[1].match(/^([0-9]{2,}) - \S.*$/u)?.[1] : undefined;
    if (slice === undefined || columns[4] !== `tasks/slice-${slice}.md`) {
      throw new Error(`execution tasks has a malformed global slice row: ${row}`);
    }
    const normalized = `slice-${slice}`;
    if (order.includes(normalized)) throw new Error(`execution tasks has a duplicate global slice row: ${normalized}`);
    order.push(normalized);
  }
  if (order.length === 0) throw new Error("execution tasks does not declare any canonical slice rows");
  return order;
}

async function requireSliceSources(workspace, slices) {
  await assertNoSymlinkComponents(path.join(workspace.executionRoot, "plans"), "execution plans directory");
  await assertNoSymlinkComponents(path.join(workspace.executionRoot, "tasks"), "execution tasks directory");
  const order = await planSliceOrder(workspace);
  const taskOrder = await taskSliceOrder(workspace);
  if (taskOrder.length !== order.length || taskOrder.some((slice, index) => slice !== order[index])) {
    throw new Error("execution tasks slice order does not exactly match the canonical serial plan order");
  }
  const expectedFiles = order.map((slice) => `${slice}.md`).sort();
  for (const directory of ["plans", "tasks"]) {
    const actualFiles = (await fs.readdir(path.join(workspace.executionRoot, directory), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && SLICE_FILE.test(entry.name))
      .map((entry) => entry.name).sort();
    if (actualFiles.length !== expectedFiles.length || actualFiles.some((name, index) => name !== expectedFiles[index])) {
      throw new Error(`execution ${directory} slice set does not exactly match the canonical serial plan order`);
    }
  }
  const missing = slices.filter((slice) => !order.includes(slice));
  if (missing.length !== 0) throw new Error(`selected slices are absent from plan.md: ${missing.join(", ")}`);
  const selected = [...slices].sort((left, right) => order.indexOf(left) - order.indexOf(right));
  const sources = [];
  for (const slice of selected) {
    if (!SLICE_FILE.test(`${slice}.md`)) throw new Error(`invalid normalized slice: ${slice}`);
    const planPath = await requireRealFile(path.join(workspace.executionRoot, "plans", `${slice}.md`), `${slice} plan`);
    const taskPath = await requireRealFile(path.join(workspace.executionRoot, "tasks", `${slice}.md`), `${slice} tasks`);
    const planAuthority = await validateExecutionArtifact(planPath, "slice-plan", slice);
    const taskAuthority = await validateExecutionArtifact(taskPath, "slice-tasks", slice);
    if (planAuthority.fingerprint !== taskAuthority.fingerprint || planAuthority.revision !== taskAuthority.revision) {
      throw new Error(`${slice} plan and task Requirements authority or Plan revision disagree`);
    }
    sources.push(planPath, taskPath);
  }
  return { selected, sources };
}

async function verifyTaskLabel(taskPath, label) {
  const text = await fs.readFile(taskPath, "utf8");
  const checklist = sectionBody(text, "Checklist");
  if (checklist === null) throw new Error(`task checklist is missing from ${taskPath}`);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = checklist.match(new RegExp(`^- \\[[ x]\\] ${escaped}(?=\\s|$)`, "gmu")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`task label ${label} must occur exactly once in ${taskPath}`);
  }
}

export async function inspectWorkspace(specPath, scopeValue, selectionValue) {
  const scope = String(scopeValue);
  if (!SCOPES.has(scope)) throw new Error(`RUNBOOK_SCOPE must be one of ${[...SCOPES].join("|")}`);
  const workspace = await resolveWorkspace(specPath);
  await validateModularAuthority(workspace);
  const selection = normalizeSelection(scope, selectionValue);
  const mandatorySources = [workspace.authorityPath, ...(await canonicalSharedSources(workspace))];
  if (new Set(["EXECUTION", "SLICE", "TASK", "MULTI_SLICE"]).has(scope)) {
    await inspectExecutionState(workspace.authorityPath);
  }

  if (scope === "EXECUTION") {
    mandatorySources.push(...(await requireExecutionBase(workspace)));
    const order = await planSliceOrder(workspace);
    const slices = await requireSliceSources(workspace, order);
    mandatorySources.push(...slices.sources);
  } else if (scope === "SLICE" || scope === "TASK") {
    mandatorySources.push(...(await requireExecutionBase(workspace)));
    const slices = await requireSliceSources(workspace, [selection.slice]);
    selection.slice = slices.selected[0];
    mandatorySources.push(...slices.sources);
    if (scope === "TASK") {
      await verifyTaskLabel(path.join(workspace.executionRoot, "tasks", `${selection.slice}.md`), selection.task);
    }
  } else if (scope === "MULTI_SLICE") {
    mandatorySources.push(...(await requireExecutionBase(workspace)));
    const slices = await requireSliceSources(workspace, selection.slices);
    selection.slices = slices.selected;
    mandatorySources.push(...slices.sources);
  } else if (scope === "SPEC") {
    const execution = await lstatOrNull(workspace.executionRoot);
    if (execution !== null) {
      if (execution.isSymbolicLink() || !execution.isDirectory()) {
        throw new Error(`execution root must be a real directory when present: ${workspace.executionRoot}`);
      }
      await inspectExecutionState(workspace.authorityPath);
      const base = await requireExecutionBase(workspace);
      mandatorySources.push(...base);
      const order = await planSliceOrder(workspace);
      mandatorySources.push(...(await requireSliceSources(workspace, order)).sources);
    }
  } else if (scope === "CUSTOM") {
    for (const relative of selection.paths) {
      const candidate = path.resolve(workspace.sourceRoot, ...relative.split("/"));
      const boundary = path.relative(workspace.sourceRoot, candidate);
      if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
        throw new Error(`custom source escapes its bounded root: ${relative}`);
      }
      await requireRealFile(candidate, `custom source ${relative}`);
      const physical = await fs.realpath(candidate);
      const physicalBoundary = path.relative(workspace.sourceRoot, physical);
      if (physical !== candidate || physicalBoundary === ".." || physicalBoundary.startsWith(`..${path.sep}`) || path.isAbsolute(physicalBoundary)) {
        throw new Error(`custom source contains a symlink component or escapes its bounded root: ${relative}`);
      }
      mandatorySources.push(physical);
    }
  }

  const uniqueSources = [...new Set(mandatorySources)].sort();
  return {
    contract_version: 1,
    workspace_kind: workspace.kind,
    authority_path: workspace.authorityPath,
    spec_root: workspace.specRoot,
    execution_root: workspace.executionRoot,
    source_root: workspace.sourceRoot,
    output_root: workspace.outputRoot,
    output_path: path.join(workspace.outputRoot, "index.html"),
    scope: { kind: scope, selection },
    mandatory_sources: uniqueSources,
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
