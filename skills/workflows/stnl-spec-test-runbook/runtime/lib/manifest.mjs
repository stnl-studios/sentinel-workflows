import * as fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson, isIgnoredMetadata, normalizeSelection } from "./core.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "contract_version", "title", "summary", "scope", "configuration", "sources", "setup",
  "data_preparation", "scenarios", "coverage", "risks", "known_issues", "gaps", "cleanup",
  "helper_artifacts",
]);
const STATUS_VALUES = new Set(["not_run", "passed", "failed", "blocked", "skipped"]);
const CRITICALITY_VALUES = new Set(["critical", "high", "medium", "low"]);
const COVERAGE_VALUES = new Set([
  "covered", "partial", "no_scenario", "not_manually_testable", "out_of_scope", "blocked",
]);
const PREPARATION_METHODS = new Set([
  "existing_data", "fixture", "factory", "seed", "manual", "api", "sql", "helper_script",
  "not_determined",
]);
const PREPARATION_STATUS = new Set(["reused", "required", "not_needed", "blocked"]);
const SENSITIVE_INPUT_NAME = /(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|authorization|cookie|session)/iu;
const SECRET_PATH_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", "credentials", "credentials.json", "id_rsa", "id_ed25519",
  "cookies", "cookies.json", "secrets", "secrets.json",
]);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\b(?:Cookie|Set-Cookie)\s*:\s*(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\r\n]{8,}/iu,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\s"',;]{8,}/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  const unknown = Object.keys(value).filter((key) => !fields.has(key)).sort();
  if (unknown.length !== 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function text(value, label, { optional = false, max = 12_000 } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value.trim();
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} has unsupported value: ${String(value)}`);
  return value;
}

function array(value, label, { min = 0, max = 500 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must be an array with ${min}-${max} items`);
  }
  return value;
}

function stringArray(value, label, { min = 0, max = 100 } = {}) {
  return array(value, label, { min, max }).map((item, index) => text(item, `${label}[${index}]`, { max: 2_000 }));
}

function safePath(value, label, { helper = false } = {}) {
  const candidate = text(value, label, { max: 500 });
  if (candidate.includes("\\") || path.isAbsolute(candidate)) {
    throw new Error(`${label} must be a relative POSIX path`);
  }
  const segments = candidate.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || isIgnoredMetadata(part))) {
    throw new Error(`${label} contains a forbidden path segment`);
  }
  for (const part of segments) {
    const lower = part.toLowerCase();
    if (SECRET_PATH_NAMES.has(lower) || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key")) {
      throw new Error(`${label} identifies a secret-bearing path`);
    }
  }
  if (helper && segments[0] === "index.html") throw new Error(`${label} cannot replace index.html`);
  return segments.join("/");
}

function detailItem(value, label, { gap = false } = {}) {
  const item = object(value, label);
  exact(item, gap ? new Set(["title", "detail", "kind"]) : new Set(["title", "detail"]), label);
  return {
    title: text(item.title, `${label}.title`, { max: 300 }),
    detail: text(item.detail, `${label}.detail`),
    ...(item.kind === undefined ? {} : { kind: text(item.kind, `${label}.kind`, { max: 100 }) }),
  };
}

function origin(value, label) {
  const item = object(value, label);
  exact(item, new Set(["kind", "ref", "label"]), label);
  return {
    kind: text(item.kind, `${label}.kind`, { max: 100 }),
    ref: text(item.ref, `${label}.ref`, { max: 300 }),
    ...(item.label === undefined ? {} : { label: text(item.label, `${label}.label`, { max: 500 }) }),
  };
}

function scenarioInput(value, label) {
  const item = object(value, label);
  exact(item, new Set(["name", "value", "sensitive"]), label);
  const sensitive = item.sensitive === true;
  if (item.sensitive !== undefined && typeof item.sensitive !== "boolean") {
    throw new Error(`${label}.sensitive must be boolean`);
  }
  if (SENSITIVE_INPUT_NAME.test(String(item.name)) && !sensitive) {
    throw new Error(`${label} has a sensitive name and must set sensitive=true without a value`);
  }
  if (sensitive && item.value !== undefined) throw new Error(`${label} is sensitive and must omit value`);
  return {
    name: text(item.name, `${label}.name`, { max: 200 }),
    sensitive,
    ...(item.value === undefined ? {} : { value: text(item.value, `${label}.value`, { max: 2_000 }) }),
  };
}

function step(value, label) {
  const item = object(value, label);
  exact(item, new Set(["action", "expected", "evidence"]), label);
  return {
    action: text(item.action, `${label}.action`),
    expected: text(item.expected, `${label}.expected`),
    evidence: item.evidence === undefined ? [] : stringArray(item.evidence, `${label}.evidence`, { max: 30 }),
  };
}

function scenario(value, label) {
  const item = object(value, label);
  exact(item, new Set([
    "id", "title", "objective", "domain", "types", "criticality", "initial_status", "origins",
    "preconditions", "environment", "inputs", "preparation", "steps", "evidence", "cleanup",
    "regressions", "risks", "notes", "known_issues", "approval_criteria",
  ]), label);
  const id = text(item.id, `${label}.id`, { max: 30 });
  if (!/^TR-[0-9]{3,}$/u.test(id)) throw new Error(`${label}.id must use deterministic TR-NNN form`);
  return {
    id,
    title: text(item.title, `${label}.title`, { max: 500 }),
    objective: text(item.objective, `${label}.objective`),
    domain: text(item.domain, `${label}.domain`, { max: 200 }),
    types: stringArray(item.types, `${label}.types`, { min: 1, max: 20 }),
    criticality: enumValue(item.criticality, CRITICALITY_VALUES, `${label}.criticality`),
    initial_status: enumValue(item.initial_status, STATUS_VALUES, `${label}.initial_status`),
    origins: array(item.origins, `${label}.origins`, { min: 1, max: 50 }).map((entry, index) => origin(entry, `${label}.origins[${index}]`)),
    preconditions: stringArray(item.preconditions, `${label}.preconditions`, { min: 1 }),
    ...(item.environment === undefined ? {} : { environment: text(item.environment, `${label}.environment`, { max: 300 }) }),
    inputs: item.inputs === undefined ? [] : array(item.inputs, `${label}.inputs`, { max: 100 }).map((entry, index) => scenarioInput(entry, `${label}.inputs[${index}]`)),
    preparation: item.preparation === undefined ? [] : stringArray(item.preparation, `${label}.preparation`),
    steps: array(item.steps, `${label}.steps`, { min: 1, max: 100 }).map((entry, index) => step(entry, `${label}.steps[${index}]`)),
    evidence: stringArray(item.evidence, `${label}.evidence`, { min: 1, max: 50 }),
    cleanup: item.cleanup === undefined ? [] : stringArray(item.cleanup, `${label}.cleanup`),
    regressions: item.regressions === undefined ? [] : stringArray(item.regressions, `${label}.regressions`),
    risks: item.risks === undefined ? [] : stringArray(item.risks, `${label}.risks`),
    notes: item.notes === undefined ? [] : stringArray(item.notes, `${label}.notes`),
    known_issues: item.known_issues === undefined ? [] : stringArray(item.known_issues, `${label}.known_issues`),
    approval_criteria: stringArray(item.approval_criteria, `${label}.approval_criteria`, { min: 1 }),
  };
}

function source(value, label) {
  const item = object(value, label);
  exact(item, new Set(["path", "role", "ids"]), label);
  return {
    path: safePath(item.path, `${label}.path`),
    role: text(item.role, `${label}.role`, { max: 100 }),
    ids: item.ids === undefined ? [] : stringArray(item.ids, `${label}.ids`, { max: 100 }),
  };
}

function preparation(value, label) {
  const item = object(value, label);
  exact(item, new Set(["title", "method", "status", "instructions", "source"]), label);
  return {
    title: text(item.title, `${label}.title`, { max: 300 }),
    method: enumValue(item.method, PREPARATION_METHODS, `${label}.method`),
    status: enumValue(item.status, PREPARATION_STATUS, `${label}.status`),
    instructions: text(item.instructions, `${label}.instructions`),
    ...(item.source === undefined ? {} : { source: safePath(item.source, `${label}.source`) }),
  };
}

function coverage(value, label) {
  const item = object(value, label);
  exact(item, new Set(["source_id", "title", "status", "scenario_ids", "rationale"]), label);
  return {
    source_id: text(item.source_id, `${label}.source_id`, { max: 100 }),
    title: text(item.title, `${label}.title`, { max: 500 }),
    status: enumValue(item.status, COVERAGE_VALUES, `${label}.status`),
    scenario_ids: stringArray(item.scenario_ids, `${label}.scenario_ids`, { max: 100 }),
    rationale: text(item.rationale, `${label}.rationale`),
  };
}

function helper(value, label) {
  const item = object(value, label);
  exact(item, new Set(["path", "purpose", "cleanup"]), label);
  return {
    path: safePath(item.path, `${label}.path`, { helper: true }),
    purpose: text(item.purpose, `${label}.purpose`),
    ...(item.cleanup === undefined ? {} : { cleanup: safePath(item.cleanup, `${label}.cleanup`, { helper: true }) }),
  };
}

function scanSecrets(value, location = "manifest") {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new Error(`${location} appears to contain a secret or credential`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) scanSecrets(value[key], `${location}.${key}`);
  }
}

export function validateManifest(raw, inspection) {
  const manifest = object(raw, "manifest");
  exact(manifest, TOP_LEVEL_FIELDS, "manifest");
  if (manifest.contract_version !== 1) throw new Error("manifest.contract_version must be 1");
  const scope = object(manifest.scope, "scope");
  exact(scope, new Set(["kind", "selection"]), "scope");
  const normalizedSelection = normalizeSelection(scope.kind, scope.selection);
  if (scope.kind !== inspection.scope.kind || canonicalJson(normalizedSelection) !== canonicalJson(inspection.scope.selection)) {
    throw new Error("manifest scope/selection does not match the explicitly inspected operation");
  }
  const manifestConfiguration = object(manifest.configuration, "configuration");
  exact(manifestConfiguration, new Set(Object.keys(inspection.configuration)), "configuration");
  if (canonicalJson(manifestConfiguration) !== canonicalJson(inspection.configuration)) {
    throw new Error("manifest configuration does not exactly match normalized RUNBOOK_OPTIONS");
  }

  const normalized = {
    contract_version: 1,
    title: text(manifest.title, "manifest.title", { max: 500 }),
    summary: text(manifest.summary, "manifest.summary"),
    scope: inspection.scope,
    configuration: structuredClone(inspection.configuration),
    sources: array(manifest.sources, "manifest.sources", { min: 1 }).map((entry, index) => source(entry, `sources[${index}]`)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    setup: array(manifest.setup ?? [], "manifest.setup", { max: 100 }).map((entry, index) => detailItem(entry, `setup[${index}]`)),
    data_preparation: array(manifest.data_preparation ?? [], "manifest.data_preparation", { max: 100 }).map((entry, index) => preparation(entry, `data_preparation[${index}]`)),
    scenarios: array(manifest.scenarios, "manifest.scenarios", { min: 1, max: 500 }).map((entry, index) => scenario(entry, `scenarios[${index}]`)).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    coverage: array(manifest.coverage ?? [], "manifest.coverage", { max: 500 }).map((entry, index) => coverage(entry, `coverage[${index}]`)).sort((left, right) => left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0),
    risks: array(manifest.risks ?? [], "manifest.risks", { max: 100 }).map((entry, index) => detailItem(entry, `risks[${index}]`)),
    known_issues: array(manifest.known_issues ?? [], "manifest.known_issues", { max: 100 }).map((entry, index) => detailItem(entry, `known_issues[${index}]`)),
    gaps: array(manifest.gaps ?? [], "manifest.gaps", { max: 100 }).map((entry, index) => detailItem(entry, `gaps[${index}]`, { gap: true })),
    cleanup: array(manifest.cleanup ?? [], "manifest.cleanup", { max: 100 }).map((entry, index) => detailItem(entry, `cleanup[${index}]`)),
    helper_artifacts: array(manifest.helper_artifacts ?? [], "manifest.helper_artifacts", { max: 50 }).map((entry, index) => helper(entry, `helper_artifacts[${index}]`)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };

  const scenarioIds = normalized.scenarios.map((entry) => entry.id);
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("scenario IDs must be unique");
  const sourcePaths = normalized.sources.map((entry) => entry.path);
  if (new Set(sourcePaths).size !== sourcePaths.length) throw new Error("source paths must be unique");
  const helperPaths = normalized.helper_artifacts.map((entry) => entry.path);
  if (new Set(helperPaths).size !== helperPaths.length) throw new Error("helper paths must be unique");
  if (!normalized.configuration.helpers && helperPaths.length !== 0) {
    throw new Error("helper_artifacts require RUNBOOK_OPTIONS.helpers=true");
  }
  const coverageIds = normalized.coverage.map((entry) => entry.source_id);
  if (new Set(coverageIds).size !== coverageIds.length) throw new Error("coverage source IDs must be unique");
  const scenarios = new Set(scenarioIds);
  for (const item of normalized.coverage) {
    const missing = item.scenario_ids.filter((id) => !scenarios.has(id));
    if (missing.length !== 0) throw new Error(`coverage ${item.source_id} references unknown scenarios: ${missing.join(", ")}`);
    if (item.status === "covered" && item.scenario_ids.length === 0) {
      throw new Error(`covered source ${item.source_id} requires at least one scenario`);
    }
    if (["no_scenario", "not_manually_testable", "out_of_scope"].includes(item.status) && item.scenario_ids.length !== 0) {
      throw new Error(`${item.status} source ${item.source_id} must not reference a scenario`);
    }
  }

  scanSecrets(normalized);
  return normalized;
}

function relativeSourcePath(sourceRoot, absolutePath) {
  const relative = path.relative(sourceRoot, absolutePath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`evidence path is outside source_root: ${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

async function requireBoundedEvidenceFile(root, relative, label) {
  const candidate = path.resolve(root, ...relative.split("/"));
  const boundary = path.relative(root, candidate);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new Error(`${label} escapes its bounded root: ${relative}`);
  }
  let metadata;
  try {
    metadata = await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new Error(`${label} does not exist: ${relative}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) throw new Error(`${label} must be a single-link real file: ${relative}`);
  if (await fs.realpath(candidate) !== candidate) throw new Error(`${label} contains a symlink component: ${relative}`);
  return { candidate, metadata };
}

function containsCanonicalId(content, id, sourcePath) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (/^(?:AC|RK|R|D|C|Q)-[0-9]{3}$/u.test(id)) {
    if (sourcePath.includes("/shared/")) return new RegExp(`^### ${escaped} — \\S`, "mu").test(content);
    if (sourcePath.endsWith("feature_spec.md")) {
      if (new RegExp(`^### ${escaped} — \\S`, "mu").test(content)) return true;
      if (!id.startsWith("R-")) return false;
      const marker = "## Requirements\n";
      const start = content.indexOf(marker);
      if (start < 0) return false;
      const bodyStart = start + marker.length;
      const next = content.indexOf("\n## ", bodyStart);
      return new RegExp(`^- ${escaped}$`, "mu").test(content.slice(bodyStart, next < 0 ? content.length : next));
    }
    return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`, "u").test(content);
  }
  if (/^slice-[0-9]{2,}$/u.test(id)) {
    const number = id.slice("slice-".length);
    if (new RegExp(`^# Slice ${number}(?: Tasks)? - `, "mu").test(content)) return true;
    for (const marker of ["## Serial Slice Order\n", "# Execution Tasks\n"]) {
      const start = content.indexOf(marker);
      if (start < 0) continue;
      const bodyStart = start + marker.length;
      const next = content.indexOf("\n## ", bodyStart);
      const section = content.slice(bodyStart, next < 0 ? content.length : next);
      if (new RegExp(`^\\| (?:\\[[ x]\\] \\| )?${number} - .+\\|.*(?:plans|tasks)\\/${escaped}\\.md \\|`, "mu").test(section)) return true;
    }
    return false;
  }
  if (/^[0-9]+\.[0-9]+$/u.test(id)) {
    const marker = "## Checklist\n";
    const start = content.indexOf(marker);
    if (start < 0) return false;
    const bodyStart = start + marker.length;
    const next = content.indexOf("\n## ", bodyStart);
    return new RegExp(`^- \\[[ x]\\] ${escaped}(?=\\s)`, "mu").test(content.slice(bodyStart, next < 0 ? content.length : next));
  }
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`, "u").test(content)
    && !sourcePath.endsWith("feature_spec.md") && !sourcePath.includes("/shared/");
}

export async function validateManifestEvidence(manifest, inspection) {
  const sourceRoot = path.resolve(inspection.source_root);
  if (await fs.realpath(sourceRoot) !== sourceRoot) throw new Error(`source_root contains a symlink component: ${sourceRoot}`);
  const sourcePaths = new Set(manifest.sources.map((source) => source.path));
  const required = inspection.mandatory_sources.map((source) => relativeSourcePath(sourceRoot, source));
  const missing = required.filter((source) => !sourcePaths.has(source));
  if (missing.length !== 0) throw new Error(`manifest.sources omits mandatory inspected sources: ${missing.join(", ")}`);

  const knownReferences = new Set(sourcePaths);
  for (const source of manifest.sources) {
    const { candidate, metadata } = await requireBoundedEvidenceFile(sourceRoot, source.path, "manifest source");
    if (source.ids.length !== 0) {
      if (metadata.size > 5_000_000) throw new Error(`manifest source exceeds the 5 MB ID validation limit: ${source.path}`);
      const content = await fs.readFile(candidate, "utf8");
      for (const id of source.ids) {
        if (!containsCanonicalId(content, id, source.path)) throw new Error(`source ID ${id} is not present as an exact canonical token in ${source.path}`);
        knownReferences.add(id);
      }
    }
  }

  for (const scenario of manifest.scenarios) {
    for (const origin of scenario.origins) {
      if (origin.kind !== "user_context" && !knownReferences.has(origin.ref)) {
        throw new Error(`scenario ${scenario.id} origin ${origin.ref} is not backed by a declared source ID or path`);
      }
    }
  }
  const scope = inspection.scope;
  const selectedSlices = scope.kind === "SLICE" || scope.kind === "TASK"
    ? new Set([scope.selection.slice])
    : scope.kind === "MULTI_SLICE"
      ? new Set(scope.selection.slices)
      : null;
  if (selectedSlices !== null) {
    const executionPrefix = `${relativeSourcePath(sourceRoot, inspection.execution_root)}/`;
    for (const source of manifest.sources) {
      const match = source.path.startsWith(executionPrefix)
        ? source.path.slice(executionPrefix.length).match(/^(?:plans|tasks)\/(slice-[0-9]{2,})\.md$/u)
        : null;
      if (match !== null && !selectedSlices.has(match[1])) {
        throw new Error(`manifest source conflicts with explicit ${scope.kind} selection: ${source.path}`);
      }
    }
    for (const scenario of manifest.scenarios) {
      for (const origin of scenario.origins.filter((item) => item.kind === "slice")) {
        if (!selectedSlices.has(origin.ref)) throw new Error(`scenario ${scenario.id} conflicts with explicit slice selection: ${origin.ref}`);
      }
      if (scope.kind === "TASK") {
        const taskOrigins = scenario.origins.filter((item) => item.kind === "task");
        if (!taskOrigins.some((origin) => origin.ref === scope.selection.task)) {
          throw new Error(`scenario ${scenario.id} does not trace to explicitly selected task: ${scope.selection.task}`);
        }
        for (const origin of taskOrigins) {
          if (origin.ref !== scope.selection.task) throw new Error(`scenario ${scenario.id} conflicts with explicit task selection: ${origin.ref}`);
        }
      }
    }
  }
  for (const item of manifest.coverage) {
    if (!knownReferences.has(item.source_id)) {
      throw new Error(`coverage source ${item.source_id} is not backed by a declared source ID or path`);
    }
  }
  for (const anchor of inspection.scope.selection.anchors ?? []) {
    const userContext = manifest.scenarios.some((scenario) => scenario.origins.some((origin) => origin.kind === "user_context" && origin.ref === anchor));
    if (!knownReferences.has(anchor) && !userContext) throw new Error(`custom anchor ${anchor} is not backed by a declared source ID, path, or explicit user_context origin`);
  }
  for (const item of manifest.data_preparation) {
    if (item.source !== undefined && !sourcePaths.has(item.source)) {
      throw new Error(`data preparation source is not declared in manifest.sources: ${item.source}`);
    }
  }
  for (const helper of manifest.helper_artifacts) {
    await requireBoundedEvidenceFile(inspection.output_root, helper.path, "helper artifact");
    if (helper.cleanup !== undefined) await requireBoundedEvidenceFile(inspection.output_root, helper.cleanup, "helper cleanup");
  }
  return manifest;
}
