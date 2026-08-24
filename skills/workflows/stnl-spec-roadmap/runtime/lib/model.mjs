import * as fs from "node:fs/promises";

import { filesystemComponentKey } from "./lifecycle/core.mjs";
import {
  ValidationError,
  canonicalJson,
  normalizeRelativePath,
  requireSingleLinkRealFile,
  resolveInsideProject,
  sha256,
} from "./core.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "contract_version", "roadmap_id", "title", "summary", "sources", "candidates", "coverage", "gaps",
]);
const SOURCE_FIELDS = new Set([
  "id", "kind", "label", "state", "path", "snapshot_sha256", "needs", "retired_reason",
]);
const NEED_FIELDS = new Set(["id", "title"]);
const CANDIDATE_FIELDS = new Set([
  "id", "title", "disposition", "disposition_reason", "spec_path", "depends_on",
  "requirements_source", "additional_context", "materialized_impact",
]);
const IMPACT_FIELDS = new Set(["summary", "handoff"]);
const COVERAGE_FIELDS = new Set([
  "id", "need_id", "title", "state", "status", "candidate_ids", "gap_ids", "overlap", "rationale",
  "retired_reason",
]);
const GAP_FIELDS = new Set([
  "id", "title", "severity", "state", "detail", "impact", "candidate_ids", "coverage_ids", "resolution",
]);

const SOURCE_KINDS = new Set(["user_stories", "text", "documentation", "adr", "contract", "rules", "spec", "other"]);
const SOURCE_STATES = new Set(["active", "retired"]);
const CANDIDATE_DISPOSITIONS = new Set(["active", "deferred", "obsolete"]);
const COVERAGE_STATES = new Set(["active", "retired"]);
const COVERAGE_STATUSES = new Set(["covered", "deferred", "blocked"]);
const OVERLAPS = new Set(["shared_context", "ambiguous_ownership"]);
const GAP_SEVERITIES = new Set(["INFO", "ATTENTION", "BLOCKING"]);
const GAP_STATES = new Set(["open", "resolved"]);
const IMPACT_HANDOFFS = new Set(["MODE=RESUME", "OPERATION=REPLAN"]);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\b(?:Cookie|Set-Cookie)\s*:\s*(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\r\n]{8,}/iu,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\s"',;]{8,}/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
];

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be a JSON object`);
  }
  return value;
}

function exact(value, allowed, required, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  const missing = [...required].filter((key) => !Object.hasOwn(value, key)).sort();
  if (unknown.length !== 0 || missing.length !== 0) {
    throw new ValidationError(`${label} fields are invalid; unknown=[${unknown.join(", ")}], missing=[${missing.join(", ")}]`);
  }
}

function text(value, label, { maximum = 12_000, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${label} must be non-empty text`);
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (normalized.length === 0) throw new ValidationError(`${label} must be non-empty text`);
  if (normalized.length > maximum) throw new ValidationError(`${label} exceeds ${maximum} characters`);
  if (normalized.includes("\0")) throw new ValidationError(`${label} contains a NUL character`);
  return normalized;
}

function array(value, label, { minimum = 0, maximum = 500 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ValidationError(`${label} must contain ${minimum}-${maximum} items`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new ValidationError(`${label} has unsupported value: ${String(value)}`);
  return value;
}

function identifier(value, label, pattern = /^[A-Z][A-Z0-9_.:-]{0,99}$/u) {
  const result = text(value, label, { maximum: 100 });
  if (!pattern.test(result)) throw new ValidationError(`${label} has a malformed stable identifier`);
  return result;
}

function identifierArray(value, label, { maximum = 500 } = {}) {
  const result = array(value, label, { maximum }).map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new ValidationError(`${label} contains duplicates`);
  return result.sort();
}

function sequenceNumber(id, prefix) {
  return Number(id.slice(prefix.length));
}

function requireContiguousIds(items, prefix, label) {
  const pattern = new RegExp(`^${prefix}[0-9]{3}$`, "u");
  const ids = items.map((item) => item.id);
  if (ids.some((id) => !pattern.test(id))) throw new ValidationError(`${label} IDs must use ${prefix}NNN form`);
  if (new Set(ids).size !== ids.length) throw new ValidationError(`${label} IDs must be unique`);
  const numbers = ids.map((id) => sequenceNumber(id, prefix)).sort((left, right) => left - right);
  if (numbers.some((number, index) => number !== index + 1)) {
    throw new ValidationError(`${label} IDs must be contiguous, monotonic, and never gap-filled`);
  }
}

function need(value, label) {
  const item = object(value, label);
  exact(item, NEED_FIELDS, NEED_FIELDS, label);
  return {
    id: identifier(item.id, `${label}.id`),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
  };
}

function source(value, label) {
  const item = object(value, label);
  exact(item, SOURCE_FIELDS, new Set(["id", "kind", "label", "state", "needs"]), label);
  const state = enumValue(item.state, SOURCE_STATES, `${label}.state`);
  const path = item.path === undefined ? undefined : normalizeRelativePath(item.path, `${label}.path`);
  const snapshot = item.snapshot_sha256 === undefined ? undefined : text(item.snapshot_sha256, `${label}.snapshot_sha256`, { maximum: 64 });
  if (snapshot !== undefined && !/^[0-9a-f]{64}$/u.test(snapshot)) {
    throw new ValidationError(`${label}.snapshot_sha256 must contain 64 lowercase hexadecimal characters`);
  }
  if (snapshot !== undefined && path === undefined) throw new ValidationError(`${label}.snapshot_sha256 requires path`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { maximum: 2_000, optional: true });
  if ((state === "retired") !== (retiredReason !== undefined)) {
    throw new ValidationError(`${label} must provide retired_reason exactly when state=retired`);
  }
  const needs = array(item.needs, `${label}.needs`, { maximum: 500 }).map((entry, index) => need(entry, `${label}.needs[${index}]`));
  if (new Set(needs.map((entry) => entry.id)).size !== needs.length) throw new ValidationError(`${label}.needs contains duplicate IDs`);
  return {
    id: identifier(item.id, `${label}.id`, /^SRC-[0-9]{3}$/u),
    kind: enumValue(item.kind, SOURCE_KINDS, `${label}.kind`),
    label: text(item.label, `${label}.label`, { maximum: 500 }),
    state,
    ...(path === undefined ? {} : { path }),
    ...(snapshot === undefined ? {} : { snapshot_sha256: snapshot }),
    needs: needs.sort((left, right) => left.id.localeCompare(right.id, "en")),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function materializedImpact(value, label) {
  const item = object(value, label);
  exact(item, IMPACT_FIELDS, IMPACT_FIELDS, label);
  return {
    summary: text(item.summary, `${label}.summary`, { maximum: 4_000 }),
    handoff: enumValue(item.handoff, IMPACT_HANDOFFS, `${label}.handoff`),
  };
}

function candidate(value, label) {
  const item = object(value, label);
  exact(item, CANDIDATE_FIELDS, new Set([
    "id", "title", "disposition", "spec_path", "depends_on", "requirements_source",
  ]), label);
  const disposition = enumValue(item.disposition, CANDIDATE_DISPOSITIONS, `${label}.disposition`);
  const dispositionReason = text(item.disposition_reason, `${label}.disposition_reason`, { maximum: 2_000, optional: true });
  if ((disposition !== "active") !== (dispositionReason !== undefined)) {
    throw new ValidationError(`${label} must provide disposition_reason exactly when disposition is deferred or obsolete`);
  }
  const additionalContext = text(item.additional_context, `${label}.additional_context`, { maximum: 20_000, optional: true });
  return {
    id: identifier(item.id, `${label}.id`, /^CAND-[0-9]{3}$/u),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    disposition,
    ...(dispositionReason === undefined ? {} : { disposition_reason: dispositionReason }),
    spec_path: normalizeRelativePath(item.spec_path, `${label}.spec_path`),
    depends_on: identifierArray(item.depends_on, `${label}.depends_on`, { maximum: 100 }),
    requirements_source: text(item.requirements_source, `${label}.requirements_source`, { maximum: 50_000 }),
    ...(additionalContext === undefined ? {} : { additional_context: additionalContext }),
    ...(item.materialized_impact === undefined ? {} : { materialized_impact: materializedImpact(item.materialized_impact, `${label}.materialized_impact`) }),
  };
}

function coverage(value, label) {
  const item = object(value, label);
  exact(item, COVERAGE_FIELDS, new Set([
    "id", "need_id", "title", "state", "status", "candidate_ids", "gap_ids", "rationale",
  ]), label);
  const state = enumValue(item.state, COVERAGE_STATES, `${label}.state`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { maximum: 2_000, optional: true });
  if ((state === "retired") !== (retiredReason !== undefined)) {
    throw new ValidationError(`${label} must provide retired_reason exactly when state=retired`);
  }
  return {
    id: identifier(item.id, `${label}.id`, /^COV-[0-9]{3}$/u),
    need_id: identifier(item.need_id, `${label}.need_id`),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    state,
    status: enumValue(item.status, COVERAGE_STATUSES, `${label}.status`),
    candidate_ids: identifierArray(item.candidate_ids, `${label}.candidate_ids`, { maximum: 100 }),
    gap_ids: identifierArray(item.gap_ids, `${label}.gap_ids`, { maximum: 100 }),
    ...(item.overlap === undefined ? {} : { overlap: enumValue(item.overlap, OVERLAPS, `${label}.overlap`) }),
    rationale: text(item.rationale, `${label}.rationale`, { maximum: 4_000 }),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function gap(value, label) {
  const item = object(value, label);
  exact(item, GAP_FIELDS, new Set([
    "id", "title", "severity", "state", "detail", "impact", "candidate_ids", "coverage_ids",
  ]), label);
  const state = enumValue(item.state, GAP_STATES, `${label}.state`);
  const resolution = text(item.resolution, `${label}.resolution`, { maximum: 4_000, optional: true });
  if ((state === "resolved") !== (resolution !== undefined)) {
    throw new ValidationError(`${label} must provide resolution exactly when state=resolved`);
  }
  return {
    id: identifier(item.id, `${label}.id`, /^GAP-[0-9]{3}$/u),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    severity: enumValue(item.severity, GAP_SEVERITIES, `${label}.severity`),
    state,
    detail: text(item.detail, `${label}.detail`, { maximum: 8_000 }),
    impact: text(item.impact, `${label}.impact`, { maximum: 4_000 }),
    candidate_ids: identifierArray(item.candidate_ids, `${label}.candidate_ids`, { maximum: 100 }),
    coverage_ids: identifierArray(item.coverage_ids, `${label}.coverage_ids`, { maximum: 500 }),
    ...(resolution === undefined ? {} : { resolution }),
  };
}

function scanSecrets(value, location = "roadmap") {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new ValidationError(`${location} appears to contain a secret or credential`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${location}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) scanSecrets(value[key], `${location}.${key}`);
  }
}

function validateDependencies(candidates) {
  const byId = new Map(candidates.map((entry) => [entry.id, entry]));
  for (const item of candidates) {
    if (item.depends_on.includes(item.id)) throw new ValidationError(`${item.id} has a self dependency`);
    for (const dependency of item.depends_on) {
      const target = byId.get(dependency);
      if (target === undefined) throw new ValidationError(`${item.id} references missing dependency ${dependency}`);
      if (target.disposition === "obsolete") throw new ValidationError(`${item.id} depends on obsolete candidate ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      throw new ValidationError(`candidate dependency cycle: ${[...trail.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const nextTrail = [...trail, id];
    for (const dependency of byId.get(id).depends_on) visit(dependency, nextTrail);
    visiting.delete(id);
    visited.add(id);
  }
  for (const item of candidates) visit(item.id, []);
}

function validateRelations(model, roadmapPath) {
  const sourceByNeed = new Map();
  for (const source of model.sources) {
    for (const need of source.needs) {
      if (sourceByNeed.has(need.id)) throw new ValidationError(`source need ID is duplicated: ${need.id}`);
      sourceByNeed.set(need.id, source);
    }
  }
  const candidateById = new Map(model.candidates.map((entry) => [entry.id, entry]));
  const coverageById = new Map(model.coverage.map((entry) => [entry.id, entry]));
  const gapById = new Map(model.gaps.map((entry) => [entry.id, entry]));
  const roadmapComponents = roadmapPath.split("/").map(filesystemComponentKey);
  const relation = (candidatePath) => {
    const candidateComponents = candidatePath.split("/").map(filesystemComponentKey);
    const common = Math.min(candidateComponents.length, roadmapComponents.length);
    const prefix = candidateComponents.slice(0, common).every((part, index) => part === roadmapComponents[index]);
    if (!prefix) return "separate";
    if (candidateComponents.length === roadmapComponents.length) return "equal";
    return candidateComponents.length < roadmapComponents.length ? "ancestor" : "descendant";
  };
  const paths = new Map();
  for (const item of model.candidates) {
    const key = filesystemComponentKey(item.spec_path);
    if (paths.has(key)) throw new ValidationError(`${item.id} and ${paths.get(key)} claim the same physical SPEC path`);
    paths.set(key, item.id);
    if (relation(item.spec_path) !== "separate") {
      throw new ValidationError(`${item.id}.spec_path collides with ROADMAP_PATH`);
    }
  }
  for (const item of model.sources.filter((entry) => entry.path !== undefined)) {
    const sourceRelation = relation(item.path);
    if (sourceRelation === "equal" || sourceRelation === "descendant") {
      throw new ValidationError(`${item.id}.path must not read from ROADMAP_PATH`);
    }
  }
  const coverageNeeds = new Map();
  for (const item of model.coverage) {
    const source = sourceByNeed.get(item.need_id);
    if (source === undefined) throw new ValidationError(`${item.id} references unknown need ${item.need_id}`);
    if (coverageNeeds.has(item.need_id)) throw new ValidationError(`need ${item.need_id} has duplicate coverage records`);
    coverageNeeds.set(item.need_id, item);
    for (const candidateId of item.candidate_ids) {
      if (!candidateById.has(candidateId)) throw new ValidationError(`${item.id} references unknown candidate ${candidateId}`);
      if (candidateById.get(candidateId).disposition === "obsolete" && item.state === "active") {
        throw new ValidationError(`${item.id} actively references obsolete candidate ${candidateId}`);
      }
    }
    for (const gapId of item.gap_ids) if (!gapById.has(gapId)) throw new ValidationError(`${item.id} references unknown gap ${gapId}`);
    for (const gapId of item.gap_ids) {
      if (!gapById.get(gapId).coverage_ids.includes(item.id)) {
        throw new ValidationError(`${item.id} and ${gapId} must reference each other`);
      }
    }
    const openGaps = item.gap_ids.map((id) => gapById.get(id)).filter((entry) => entry.state === "open");
    if ((source.state === "retired") !== (item.state === "retired")) {
      throw new ValidationError(`${item.id} state must match source ${source.id} state`);
    }
    if (item.state === "retired") continue;
    if (item.status === "covered" && item.candidate_ids.length === 0) {
      throw new ValidationError(`${item.id} covered status requires a candidate`);
    }
    if (item.status === "deferred") {
      if (item.candidate_ids.length !== 0) throw new ValidationError(`${item.id} deferred status cannot claim a candidate`);
      if (!openGaps.some((entry) => entry.severity === "INFO" || entry.severity === "ATTENTION")) {
        throw new ValidationError(`${item.id} deferred status requires an open INFO or ATTENTION gap`);
      }
    }
    if (item.status === "blocked" && !openGaps.some((entry) => entry.severity === "BLOCKING")) {
      throw new ValidationError(`${item.id} blocked status requires an open BLOCKING gap`);
    }
    if (item.candidate_ids.length > 1 && item.overlap === undefined) {
      throw new ValidationError(`${item.id} has overlapping candidates without overlap classification`);
    }
    if (item.candidate_ids.length < 2 && item.overlap !== undefined) {
      throw new ValidationError(`${item.id} overlap classification requires at least two candidates`);
    }
    if (item.overlap === "ambiguous_ownership" && !openGaps.some((entry) => entry.severity !== "INFO")) {
      throw new ValidationError(`${item.id} ambiguous ownership requires an open ATTENTION or BLOCKING gap`);
    }
  }
  const uncovered = [...sourceByNeed.keys()].filter((id) => !coverageNeeds.has(id));
  if (uncovered.length !== 0) throw new ValidationError(`source needs are missing coverage: ${uncovered.sort().join(", ")}`);
  for (const item of model.gaps) {
    for (const candidateId of item.candidate_ids) if (!candidateById.has(candidateId)) throw new ValidationError(`${item.id} references unknown candidate ${candidateId}`);
    for (const coverageId of item.coverage_ids) if (!coverageById.has(coverageId)) throw new ValidationError(`${item.id} references unknown coverage ${coverageId}`);
    for (const coverageId of item.coverage_ids) {
      if (!coverageById.get(coverageId).gap_ids.includes(item.id)) {
        throw new ValidationError(`${item.id} and ${coverageId} must reference each other`);
      }
    }
  }
  validateDependencies(model.candidates);
}

export function validateRoadmap(raw, { roadmapPath = "docs/roadmap" } = {}) {
  const roadmap = object(raw, "roadmap");
  exact(roadmap, TOP_LEVEL_FIELDS, TOP_LEVEL_FIELDS, "roadmap");
  if (roadmap.contract_version !== 1) throw new ValidationError("roadmap.contract_version must be 1");
  const normalized = {
    contract_version: 1,
    roadmap_id: identifier(roadmap.roadmap_id, "roadmap.roadmap_id", /^RM-[A-Z0-9][A-Z0-9-]{0,62}$/u),
    title: text(roadmap.title, "roadmap.title", { maximum: 500 }),
    summary: text(roadmap.summary, "roadmap.summary", { maximum: 12_000 }),
    sources: array(roadmap.sources, "roadmap.sources", { minimum: 1, maximum: 100 }).map((entry, index) => source(entry, `sources[${index}]`)).sort((left, right) => left.id.localeCompare(right.id, "en")),
    candidates: array(roadmap.candidates, "roadmap.candidates", { minimum: 1, maximum: 500 }).map((entry, index) => candidate(entry, `candidates[${index}]`)).sort((left, right) => left.id.localeCompare(right.id, "en")),
    coverage: array(roadmap.coverage, "roadmap.coverage", { minimum: 1, maximum: 2_000 }).map((entry, index) => coverage(entry, `coverage[${index}]`)).sort((left, right) => left.id.localeCompare(right.id, "en")),
    gaps: array(roadmap.gaps, "roadmap.gaps", { maximum: 1_000 }).map((entry, index) => gap(entry, `gaps[${index}]`)).sort((left, right) => left.id.localeCompare(right.id, "en")),
  };
  requireContiguousIds(normalized.sources, "SRC-", "source");
  requireContiguousIds(normalized.candidates, "CAND-", "candidate");
  requireContiguousIds(normalized.coverage, "COV-", "coverage");
  requireContiguousIds(normalized.gaps, "GAP-", "gap");
  const sourcePaths = normalized.sources.flatMap((item) => item.path === undefined ? [] : [filesystemComponentKey(item.path)]);
  if (new Set(sourcePaths).size !== sourcePaths.length) throw new ValidationError("source paths must be physically unique");
  validateRelations(normalized, roadmapPath);
  scanSecrets(normalized);
  return normalized;
}

function immutableCandidateIdentity(item) {
  return canonicalJson({ id: item.id, title: item.title, spec_path: item.spec_path });
}

function immutableSourceIdentity(item) {
  return canonicalJson({ id: item.id, kind: item.kind, label: item.label, path: item.path ?? null });
}

function terminalSourceContent(item) {
  const copy = { ...item };
  delete copy.snapshot_sha256;
  return canonicalJson(copy);
}

function immutableNeedIdentity(sourceId, item) {
  return canonicalJson({ source_id: sourceId, id: item.id, title: item.title });
}

function immutableCoverageIdentity(item) {
  return canonicalJson({ id: item.id, need_id: item.need_id, title: item.title });
}

function immutableGapIdentity(item) {
  return canonicalJson({ id: item.id, title: item.title });
}

function materialCandidateContent(item) {
  const copy = { ...item };
  delete copy.materialized_impact;
  return canonicalJson(copy);
}

function ensurePreserved(previousItems, nextItems, label) {
  const nextIds = new Set(nextItems.map((item) => item.id));
  const missing = previousItems.map((item) => item.id).filter((id) => !nextIds.has(id));
  if (missing.length !== 0) throw new ValidationError(`${label} identities cannot be removed; retire or resolve them: ${missing.join(", ")}`);
}

export function validateReconcile(previous, next, projections = new Map()) {
  if (previous.roadmap_id !== next.roadmap_id) throw new ValidationError("RECONCILE cannot change roadmap_id");
  for (const [label, before, after] of [
    ["source", previous.sources, next.sources],
    ["candidate", previous.candidates, next.candidates],
    ["coverage", previous.coverage, next.coverage],
    ["gap", previous.gaps, next.gaps],
  ]) ensurePreserved(before, after, label);
  const nextSources = new Map(next.sources.map((item) => [item.id, item]));
  for (const before of previous.sources) {
    const after = nextSources.get(before.id);
    if (immutableSourceIdentity(before) !== immutableSourceIdentity(after)) {
      throw new ValidationError(`${before.id} stable source identity is immutable; retire and allocate a new source`);
    }
    const afterNeeds = new Map(after.needs.map((item) => [item.id, item]));
    const missingNeeds = before.needs.filter((item) => !afterNeeds.has(item.id)).map((item) => item.id);
    if (missingNeeds.length !== 0) {
      throw new ValidationError(`${before.id} need identities cannot be removed: ${missingNeeds.join(", ")}`);
    }
    for (const needBefore of before.needs) {
      if (immutableNeedIdentity(before.id, needBefore) !== immutableNeedIdentity(after.id, afterNeeds.get(needBefore.id))) {
        throw new ValidationError(`${needBefore.id} stable need identity is immutable; retire its coverage instead of reusing it`);
      }
    }
    if (before.state === "retired" && terminalSourceContent(before) !== terminalSourceContent(after)) {
      throw new ValidationError(`${before.id} is a terminal retired source tombstone`);
    }
  }
  const nextCandidates = new Map(next.candidates.map((item) => [item.id, item]));
  for (const before of previous.candidates) {
    const after = nextCandidates.get(before.id);
    if (immutableCandidateIdentity(before) !== immutableCandidateIdentity(after)) {
      throw new ValidationError(`${before.id} stable title and SPEC path are immutable; retire and allocate a new candidate`);
    }
    if (before.disposition === "obsolete" && canonicalJson(before) !== canonicalJson(after)) {
      throw new ValidationError(`${before.id} is a terminal obsolete candidate tombstone`);
    }
    const projection = projections.get(before.id);
    const materialized = projection?.materialization === "materialized";
    if (materialized && materialCandidateContent(before) !== materialCandidateContent(after)
      && after.materialized_impact === undefined) {
      throw new ValidationError(`${before.id} changed after materialization without materialized_impact`);
    }
  }
  const nextCoverage = new Map(next.coverage.map((item) => [item.id, item]));
  for (const before of previous.coverage) {
    const after = nextCoverage.get(before.id);
    if (immutableCoverageIdentity(before) !== immutableCoverageIdentity(after)) {
      throw new ValidationError(`${before.id} stable coverage identity is immutable; retire and allocate a new coverage record`);
    }
    if (before.state === "retired" && canonicalJson(before) !== canonicalJson(after)) {
      throw new ValidationError(`${before.id} is a terminal retired coverage tombstone`);
    }
  }
  const nextGaps = new Map(next.gaps.map((item) => [item.id, item]));
  for (const before of previous.gaps) {
    const after = nextGaps.get(before.id);
    if (immutableGapIdentity(before) !== immutableGapIdentity(after)) {
      throw new ValidationError(`${before.id} stable gap identity is immutable; resolve and allocate a new gap`);
    }
    if (before.state === "resolved" && canonicalJson(before) !== canonicalJson(after)) {
      throw new ValidationError(`${before.id} is a terminal resolved gap tombstone`);
    }
  }
  return next;
}

export async function hydrateSourceFingerprints(model, projectRoot) {
  const sources = [];
  for (const item of model.sources) {
    if (item.path === undefined) {
      const copy = { ...item };
      delete copy.snapshot_sha256;
      sources.push(copy);
      continue;
    }
    const resolved = await resolveInsideProject(projectRoot, item.path, `${item.id}.path`);
    await requireSingleLinkRealFile(resolved.absolute, `${item.id} source`, 5_000_000);
    const bytes = await fs.readFile(resolved.absolute);
    sources.push({ ...item, snapshot_sha256: sha256(bytes) });
  }
  return { ...model, sources };
}
