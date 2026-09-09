import * as fs from "node:fs/promises";

import {
  ValidationError,
  canonicalJson,
  filesystemKey,
  normalizeRelativePath,
  requireSingleLinkRealFile,
  resolveInsideProject,
  sha256,
} from "./core.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "contract_version", "refinement_id", "title", "summary", "input_assessment", "exploration",
  "sources", "needs", "evidence", "relationships", "questions", "constraints", "findings",
  "final_assessment", "handoff",
]);
const INPUT_FIELDS = new Set(["format", "quality", "summary"]);
const EXPLORATION_FIELDS = new Set(["status", "anchors", "searches", "files_read", "stop_reason", "limitations"]);
const SOURCE_FIELDS = new Set([
  "id", "kind", "label", "state", "external_id", "path", "snapshot_sha256", "original_text", "retired_reason",
]);
const NEED_FIELDS = new Set([
  "id", "title", "state", "source_ids", "statement", "actor", "preconditions", "acceptance_signals",
  "negative_signals", "retired_reason",
]);
const EVIDENCE_FIELDS = new Set([
  "id", "kind", "state", "summary", "detail", "confidence", "source_ids", "need_ids", "path", "locator",
  "snapshot_sha256", "surface", "superseded_reason",
]);
const RELATIONSHIP_FIELDS = new Set([
  "id", "type", "title", "state", "need_ids", "evidence_ids", "detail", "from_need_id", "to_need_id",
  "retired_reason",
]);
const QUESTION_FIELDS = new Set([
  "id", "question", "status", "why_material", "need_ids", "finding_ids", "evidence_ids", "answer",
]);
const CONSTRAINT_FIELDS = new Set(["id", "statement", "state", "need_ids", "evidence_ids", "retired_reason"]);
const FINDING_FIELDS = new Set([
  "id", "title", "type", "severity", "disposition", "need_ids", "evidence_ids", "relationship_ids",
  "question_ids", "problem", "why_it_matters", "impact", "resolution", "bypass", "reopened_reason",
]);
const RESOLUTION_FIELDS = new Set([
  "proposal", "verdict", "rationale", "checks", "supporting_evidence_ids", "remaining_gap",
]);
const CHECK_FIELDS = new Set(["behavior_defined", "ambiguity_closed", "repository_consistent", "no_new_gap_introduced", "problem_fully_addressed"]);
const BYPASS_FIELDS = new Set(["reason", "known_risk"]);
const ASSESSMENT_FIELDS = new Set(["boundary", "capability_count", "decomposition_value", "rationale"]);
const HANDOFF_FIELDS = new Set([
  "outcome", "reason", "blocker_ids", "carried_finding_ids", "next_workflow", "suggested_next_operation", "payload",
]);
const PAYLOAD_FIELDS = new Set([
  "kind", "need_ids", "finding_ids", "question_ids", "constraint_ids", "relationship_ids", "evidence_ids",
  "suggested_spec_title", "suggested_spec_path", "requirements_source", "roadmap_source",
]);

const INPUT_FORMATS = new Set(["STRUCTURED", "MIXED", "UNSTRUCTURED"]);
const INPUT_QUALITIES = new Set(["SUFFICIENT", "PARTIAL", "POOR"]);
const EXPLORATION_STATUSES = new Set(["SUFFICIENT", "INSUFFICIENT", "NOT_NEEDED"]);
const SOURCE_KINDS = new Set([
  "USER_STORY", "EPIC", "FEATURE", "TEXT", "MARKDOWN", "DOCUMENTATION", "ACCEPTANCE_CRITERIA", "OTHER",
]);
const SOURCE_STATES = new Set(["ACTIVE", "RETIRED"]);
const NEED_STATES = new Set(["ACTIVE", "RETIRED"]);
const EVIDENCE_KINDS = new Set([
  "SOURCE_ASSERTION", "REPOSITORY_OBSERVATION", "USER_DECISION", "INFERENCE", "HYPOTHESIS", "RESOLUTION_VALIDATION",
]);
const EVIDENCE_STATES = new Set(["ACTIVE", "SUPERSEDED"]);
const CONFIDENCES = new Set(["CONFIRMED", "SUPPORTED", "TENTATIVE"]);
const RELATIONSHIP_TYPES = new Set([
  "DEPENDENCY", "CONFLICT", "OVERLAP", "SHARED_TECHNICAL_SURFACE", "SHARED_AUTHORITY",
]);
const RELATIONSHIP_STATES = new Set(["ACTIVE", "RETIRED"]);
const QUESTION_STATUSES = new Set(["OPEN", "ANSWERED"]);
const CONSTRAINT_STATES = new Set(["ACTIVE", "RETIRED"]);
const FINDING_TYPES = new Set([
  "REQUIREMENT_GAP", "TECHNICAL_GAP", "CROSS_REQUIREMENT_GAP", "REPOSITORY_CONFLICT", "RISK",
]);
const SEVERITIES = new Set(["INFO", "ATTENTION", "BLOCKING"]);
const DISPOSITIONS = new Set(["open", "resolved", "bypassed"]);
const RESOLUTION_VERDICTS = new Set(["accepted", "rejected", "inconclusive"]);
const CHECK_VALUES = new Set(["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"]);
const BOUNDARIES = new Set(["UNITARY", "MULTIPLE", "AMBIGUOUS", "UNESTABLISHED"]);
const DECOMPOSITION_VALUES = new Set(["NONE", "MATERIAL", "UNCLEAR"]);
const OUTCOMES = new Set(["BLOCKED", "READY_FOR_SPEC", "READY_FOR_ROADMAP"]);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:Cookie|Set-Cookie)\s*:\s*(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\r\n]{8,}/iu,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?(?!(?:<redacted>|redacted|not[_ -]?set|placeholder)\b)[^\s"',;]{8,}/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];
const HOST_PATH_PATTERNS = [
  /(?:^|[\s"'`(=:\[])\/(?:Users|home|root|workspace|workspaces|repos?|opt|srv|mnt|private|tmp|var)(?:\/|$)/iu,
  /(?:^|[\s"'`(])[A-Za-z]:[\\/][^\s"'`<>]*/u,
  /(?:^|[\s"'`(])\\\\[^\\\s"'`<>]+\\[^\s"'`<>]*/u,
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const CPF_PATTERN = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/u;

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

function text(value, label, { optional = false, maximum = 12_000 } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${label} must be non-empty text`);
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
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

function integer(value, label, { minimum = 0, maximum = 10_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function identifier(value, label, pattern) {
  const result = text(value, label, { maximum: 100 });
  if (!pattern.test(result)) throw new ValidationError(`${label} has a malformed stable identifier`);
  return result;
}

function textArray(value, label, { minimum = 0, maximum = 100, itemMaximum = 2_000 } = {}) {
  const result = array(value, label, { minimum, maximum }).map((item, index) => text(item, `${label}[${index}]`, { maximum: itemMaximum }));
  if (new Set(result).size !== result.length) throw new ValidationError(`${label} contains duplicates`);
  return result;
}

function identifierArray(value, label, pattern, options = {}) {
  const result = array(value, label, options).map((item, index) => identifier(item, `${label}[${index}]`, pattern));
  if (new Set(result).size !== result.length) throw new ValidationError(`${label} contains duplicates`);
  return result.sort();
}

function exactIds(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new ValidationError(`${label} must exactly equal [${[...expected].sort().join(", ")}]`);
  }
}

function requireContiguousIds(items, prefix, label) {
  const pattern = new RegExp(`^${prefix}[0-9]{3}$`, "u");
  const ids = items.map((item) => item.id);
  if (ids.some((id) => !pattern.test(id))) throw new ValidationError(`${label} IDs must use ${prefix}NNN form`);
  if (new Set(ids).size !== ids.length) throw new ValidationError(`${label} IDs must be unique`);
  const values = ids.map((id) => Number(id.slice(prefix.length))).sort((left, right) => left - right);
  if (values.some((value, index) => value !== index + 1)) {
    throw new ValidationError(`${label} IDs must be contiguous and monotonic`);
  }
}

function inputAssessment(value) {
  const item = object(value, "input_assessment");
  exact(item, INPUT_FIELDS, INPUT_FIELDS, "input_assessment");
  return {
    format: enumValue(item.format, INPUT_FORMATS, "input_assessment.format"),
    quality: enumValue(item.quality, INPUT_QUALITIES, "input_assessment.quality"),
    summary: text(item.summary, "input_assessment.summary", { maximum: 4_000 }),
  };
}

function exploration(value) {
  const item = object(value, "exploration");
  exact(item, EXPLORATION_FIELDS, EXPLORATION_FIELDS, "exploration");
  const filesRead = array(item.files_read, "exploration.files_read", { maximum: 200 })
    .map((entry, index) => normalizeRelativePath(entry, `exploration.files_read[${index}]`));
  if (new Set(filesRead.map(filesystemKey)).size !== filesRead.length) throw new ValidationError("exploration.files_read contains physical duplicates");
  return {
    status: enumValue(item.status, EXPLORATION_STATUSES, "exploration.status"),
    anchors: textArray(item.anchors, "exploration.anchors", { maximum: 100, itemMaximum: 500 }),
    searches: textArray(item.searches, "exploration.searches", { maximum: 100, itemMaximum: 500 }),
    files_read: filesRead.sort(),
    stop_reason: text(item.stop_reason, "exploration.stop_reason", { maximum: 4_000 }),
    limitations: textArray(item.limitations, "exploration.limitations", { maximum: 100 }),
  };
}

function source(value, label) {
  const item = object(value, label);
  exact(item, SOURCE_FIELDS, new Set(["id", "kind", "label", "state", "original_text"]), label);
  const state = enumValue(item.state, SOURCE_STATES, `${label}.state`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { optional: true, maximum: 2_000 });
  if ((state === "RETIRED") !== (retiredReason !== undefined)) throw new ValidationError(`${label} requires retired_reason exactly when RETIRED`);
  const pathValue = item.path === undefined ? undefined : normalizeRelativePath(item.path, `${label}.path`);
  const snapshot = text(item.snapshot_sha256, `${label}.snapshot_sha256`, { optional: true, maximum: 64 });
  if (snapshot !== undefined && !/^[0-9a-f]{64}$/u.test(snapshot)) throw new ValidationError(`${label}.snapshot_sha256 must be 64 lowercase hexadecimal characters`);
  if (snapshot !== undefined && pathValue === undefined) throw new ValidationError(`${label}.snapshot_sha256 requires path`);
  return {
    id: identifier(item.id, `${label}.id`, /^SRC-[0-9]{3}$/u),
    kind: enumValue(item.kind, SOURCE_KINDS, `${label}.kind`),
    label: text(item.label, `${label}.label`, { maximum: 500 }),
    state,
    ...(item.external_id === undefined ? {} : { external_id: text(item.external_id, `${label}.external_id`, { maximum: 200 }) }),
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(snapshot === undefined ? {} : { snapshot_sha256: snapshot }),
    original_text: text(item.original_text, `${label}.original_text`, { maximum: 100_000 }),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function need(value, label) {
  const item = object(value, label);
  exact(item, NEED_FIELDS, new Set([
    "id", "title", "state", "source_ids", "statement", "preconditions", "acceptance_signals", "negative_signals",
  ]), label);
  const state = enumValue(item.state, NEED_STATES, `${label}.state`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { optional: true, maximum: 2_000 });
  if ((state === "RETIRED") !== (retiredReason !== undefined)) throw new ValidationError(`${label} requires retired_reason exactly when RETIRED`);
  return {
    id: identifier(item.id, `${label}.id`, /^NEED-[0-9]{3}$/u),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    state,
    source_ids: identifierArray(item.source_ids, `${label}.source_ids`, /^SRC-[0-9]{3}$/u, { minimum: 1, maximum: 50 }),
    statement: text(item.statement, `${label}.statement`, { maximum: 12_000 }),
    ...(item.actor === undefined ? {} : { actor: text(item.actor, `${label}.actor`, { maximum: 500 }) }),
    preconditions: textArray(item.preconditions, `${label}.preconditions`, { maximum: 100 }),
    acceptance_signals: textArray(item.acceptance_signals, `${label}.acceptance_signals`, { maximum: 100 }),
    negative_signals: textArray(item.negative_signals, `${label}.negative_signals`, { maximum: 100 }),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function evidence(value, label) {
  const item = object(value, label);
  exact(item, EVIDENCE_FIELDS, new Set(["id", "kind", "state", "summary", "detail", "confidence", "source_ids", "need_ids"]), label);
  const kind = enumValue(item.kind, EVIDENCE_KINDS, `${label}.kind`);
  const state = enumValue(item.state, EVIDENCE_STATES, `${label}.state`);
  const supersededReason = text(item.superseded_reason, `${label}.superseded_reason`, { optional: true, maximum: 2_000 });
  if ((state === "SUPERSEDED") !== (supersededReason !== undefined)) throw new ValidationError(`${label} requires superseded_reason exactly when SUPERSEDED`);
  const pathValue = item.path === undefined ? undefined : normalizeRelativePath(item.path, `${label}.path`);
  const locator = text(item.locator, `${label}.locator`, { optional: true, maximum: 1_000 });
  const snapshot = text(item.snapshot_sha256, `${label}.snapshot_sha256`, { optional: true, maximum: 64 });
  if (snapshot !== undefined && !/^[0-9a-f]{64}$/u.test(snapshot)) throw new ValidationError(`${label}.snapshot_sha256 must be 64 lowercase hexadecimal characters`);
  if (kind === "REPOSITORY_OBSERVATION" && (pathValue === undefined || locator === undefined)) {
    throw new ValidationError(`${label} repository evidence requires path and locator`);
  }
  if (kind !== "REPOSITORY_OBSERVATION" && (pathValue !== undefined || locator !== undefined || snapshot !== undefined)) {
    throw new ValidationError(`${label} path, locator, and snapshot are reserved for repository evidence`);
  }
  const confidence = enumValue(item.confidence, CONFIDENCES, `${label}.confidence`);
  if (kind === "HYPOTHESIS" && confidence !== "TENTATIVE") throw new ValidationError(`${label} hypothesis must be TENTATIVE`);
  if (new Set(["INFERENCE", "HYPOTHESIS"]).has(kind) && confidence === "CONFIRMED") {
    throw new ValidationError(`${label} inference or hypothesis cannot be CONFIRMED`);
  }
  if (kind === "SOURCE_ASSERTION" && item.source_ids.length === 0) throw new ValidationError(`${label} source assertion requires source_ids`);
  return {
    id: identifier(item.id, `${label}.id`, /^EVD-[0-9]{3}$/u),
    kind,
    state,
    summary: text(item.summary, `${label}.summary`, { maximum: 1_000 }),
    detail: text(item.detail, `${label}.detail`, { maximum: 12_000 }),
    confidence,
    source_ids: identifierArray(item.source_ids, `${label}.source_ids`, /^SRC-[0-9]{3}$/u, { maximum: 100 }),
    need_ids: identifierArray(item.need_ids, `${label}.need_ids`, /^NEED-[0-9]{3}$/u, { maximum: 100 }),
    ...(pathValue === undefined ? {} : { path: pathValue, locator, ...(snapshot === undefined ? {} : { snapshot_sha256: snapshot }) }),
    ...(item.surface === undefined ? {} : { surface: text(item.surface, `${label}.surface`, { maximum: 200 }) }),
    ...(supersededReason === undefined ? {} : { superseded_reason: supersededReason }),
  };
}

function relationship(value, label) {
  const item = object(value, label);
  exact(item, RELATIONSHIP_FIELDS, new Set(["id", "type", "title", "state", "need_ids", "evidence_ids", "detail"]), label);
  const type = enumValue(item.type, RELATIONSHIP_TYPES, `${label}.type`);
  const state = enumValue(item.state, RELATIONSHIP_STATES, `${label}.state`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { optional: true, maximum: 2_000 });
  if ((state === "RETIRED") !== (retiredReason !== undefined)) throw new ValidationError(`${label} requires retired_reason exactly when RETIRED`);
  const needIds = identifierArray(item.need_ids, `${label}.need_ids`, /^NEED-[0-9]{3}$/u, { minimum: 2, maximum: 100 });
  const from = item.from_need_id === undefined ? undefined : identifier(item.from_need_id, `${label}.from_need_id`, /^NEED-[0-9]{3}$/u);
  const to = item.to_need_id === undefined ? undefined : identifier(item.to_need_id, `${label}.to_need_id`, /^NEED-[0-9]{3}$/u);
  if (type === "DEPENDENCY") {
    if (from === undefined || to === undefined || from === to || !needIds.includes(from) || !needIds.includes(to)) {
      throw new ValidationError(`${label} dependency requires distinct from_need_id and to_need_id in need_ids`);
    }
  } else if (from !== undefined || to !== undefined) {
    throw new ValidationError(`${label} direction fields are reserved for DEPENDENCY`);
  }
  return {
    id: identifier(item.id, `${label}.id`, /^REL-[0-9]{3}$/u),
    type,
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    state,
    need_ids: needIds,
    evidence_ids: identifierArray(item.evidence_ids, `${label}.evidence_ids`, /^EVD-[0-9]{3}$/u, { maximum: 100 }),
    detail: text(item.detail, `${label}.detail`, { maximum: 8_000 }),
    ...(from === undefined ? {} : { from_need_id: from, to_need_id: to }),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function question(value, label) {
  const item = object(value, label);
  exact(item, QUESTION_FIELDS, new Set(["id", "question", "status", "why_material", "need_ids", "finding_ids", "evidence_ids"]), label);
  const status = enumValue(item.status, QUESTION_STATUSES, `${label}.status`);
  const answer = text(item.answer, `${label}.answer`, { optional: true, maximum: 8_000 });
  if ((status === "ANSWERED") !== (answer !== undefined)) throw new ValidationError(`${label} requires answer exactly when ANSWERED`);
  return {
    id: identifier(item.id, `${label}.id`, /^QST-[0-9]{3}$/u),
    question: text(item.question, `${label}.question`, { maximum: 2_000 }),
    status,
    why_material: text(item.why_material, `${label}.why_material`, { maximum: 4_000 }),
    need_ids: identifierArray(item.need_ids, `${label}.need_ids`, /^NEED-[0-9]{3}$/u, { minimum: 1, maximum: 100 }),
    finding_ids: identifierArray(item.finding_ids, `${label}.finding_ids`, /^FND-[0-9]{3}$/u, { minimum: 1, maximum: 100 }),
    evidence_ids: identifierArray(item.evidence_ids, `${label}.evidence_ids`, /^EVD-[0-9]{3}$/u, { maximum: 100 }),
    ...(answer === undefined ? {} : { answer }),
  };
}

function constraint(value, label) {
  const item = object(value, label);
  exact(item, CONSTRAINT_FIELDS, new Set(["id", "statement", "state", "need_ids", "evidence_ids"]), label);
  const state = enumValue(item.state, CONSTRAINT_STATES, `${label}.state`);
  const retiredReason = text(item.retired_reason, `${label}.retired_reason`, { optional: true, maximum: 2_000 });
  if ((state === "RETIRED") !== (retiredReason !== undefined)) throw new ValidationError(`${label} requires retired_reason exactly when RETIRED`);
  return {
    id: identifier(item.id, `${label}.id`, /^CON-[0-9]{3}$/u),
    statement: text(item.statement, `${label}.statement`, { maximum: 4_000 }),
    state,
    need_ids: identifierArray(item.need_ids, `${label}.need_ids`, /^NEED-[0-9]{3}$/u, { minimum: 1, maximum: 100 }),
    evidence_ids: identifierArray(item.evidence_ids, `${label}.evidence_ids`, /^EVD-[0-9]{3}$/u, { minimum: 1, maximum: 100 }),
    ...(retiredReason === undefined ? {} : { retired_reason: retiredReason }),
  };
}

function resolution(value, label) {
  const item = object(value, label);
  exact(item, RESOLUTION_FIELDS, new Set(["proposal", "verdict", "rationale", "checks", "supporting_evidence_ids"]), label);
  const verdict = enumValue(item.verdict, RESOLUTION_VERDICTS, `${label}.verdict`);
  const checksValue = object(item.checks, `${label}.checks`);
  exact(checksValue, CHECK_FIELDS, CHECK_FIELDS, `${label}.checks`);
  const checks = Object.fromEntries([...CHECK_FIELDS].map((key) => [key, enumValue(checksValue[key], CHECK_VALUES, `${label}.checks.${key}`)]));
  const remainingGap = text(item.remaining_gap, `${label}.remaining_gap`, { optional: true, maximum: 4_000 });
  if (verdict === "accepted") {
    if (checks.problem_fully_addressed !== "PASS" || checks.ambiguity_closed !== "PASS"
      || checks.no_new_gap_introduced !== "PASS" || remainingGap !== undefined
      || !new Set(["PASS", "NOT_APPLICABLE"]).has(checks.repository_consistent)
      || !new Set(["PASS", "NOT_APPLICABLE"]).has(checks.behavior_defined)) {
      throw new ValidationError(`${label} accepted verdict does not demonstrate closure`);
    }
  } else if (remainingGap === undefined) {
    throw new ValidationError(`${label} ${verdict} verdict requires remaining_gap`);
  }
  if (verdict === "rejected" && !Object.values(checks).includes("FAIL")) {
    throw new ValidationError(`${label} rejected verdict requires at least one failed check`);
  }
  if (verdict === "inconclusive" && !Object.values(checks).includes("UNKNOWN")) {
    throw new ValidationError(`${label} inconclusive verdict requires at least one unknown check`);
  }
  return {
    proposal: text(item.proposal, `${label}.proposal`, { maximum: 12_000 }),
    verdict,
    rationale: text(item.rationale, `${label}.rationale`, { maximum: 8_000 }),
    checks,
    supporting_evidence_ids: identifierArray(item.supporting_evidence_ids, `${label}.supporting_evidence_ids`, /^EVD-[0-9]{3}$/u, { maximum: 100 }),
    ...(remainingGap === undefined ? {} : { remaining_gap: remainingGap }),
  };
}

function finding(value, label) {
  const item = object(value, label);
  exact(item, FINDING_FIELDS, new Set([
    "id", "title", "type", "severity", "disposition", "need_ids", "evidence_ids", "relationship_ids",
    "question_ids", "problem", "why_it_matters", "impact",
  ]), label);
  const disposition = enumValue(item.disposition, DISPOSITIONS, `${label}.disposition`);
  const resolutionValue = item.resolution === undefined ? undefined : resolution(item.resolution, `${label}.resolution`);
  const bypassValue = item.bypass === undefined ? undefined : (() => {
    const candidate = object(item.bypass, `${label}.bypass`);
    exact(candidate, BYPASS_FIELDS, BYPASS_FIELDS, `${label}.bypass`);
    return {
      reason: text(candidate.reason, `${label}.bypass.reason`, { maximum: 4_000 }),
      known_risk: text(candidate.known_risk, `${label}.bypass.known_risk`, { maximum: 4_000 }),
    };
  })();
  if (disposition === "resolved" && resolutionValue?.verdict !== "accepted") throw new ValidationError(`${label} resolved finding requires an accepted resolution`);
  if (disposition === "resolved" && bypassValue !== undefined) throw new ValidationError(`${label} resolved finding cannot be bypassed`);
  if (disposition === "bypassed" && bypassValue === undefined) throw new ValidationError(`${label} bypassed finding requires bypass rationale and known risk`);
  if (disposition === "bypassed" && resolutionValue?.verdict === "accepted") throw new ValidationError(`${label} bypass cannot masquerade as accepted resolution`);
  if (disposition === "open" && (bypassValue !== undefined || resolutionValue?.verdict === "accepted")) {
    throw new ValidationError(`${label} open finding cannot contain bypass or accepted resolution`);
  }
  return {
    id: identifier(item.id, `${label}.id`, /^FND-[0-9]{3}$/u),
    title: text(item.title, `${label}.title`, { maximum: 500 }),
    type: enumValue(item.type, FINDING_TYPES, `${label}.type`),
    severity: enumValue(item.severity, SEVERITIES, `${label}.severity`),
    disposition,
    need_ids: identifierArray(item.need_ids, `${label}.need_ids`, /^NEED-[0-9]{3}$/u, { minimum: 1, maximum: 100 }),
    evidence_ids: identifierArray(item.evidence_ids, `${label}.evidence_ids`, /^EVD-[0-9]{3}$/u, { maximum: 100 }),
    relationship_ids: identifierArray(item.relationship_ids, `${label}.relationship_ids`, /^REL-[0-9]{3}$/u, { maximum: 100 }),
    question_ids: identifierArray(item.question_ids, `${label}.question_ids`, /^QST-[0-9]{3}$/u, { maximum: 100 }),
    problem: text(item.problem, `${label}.problem`, { maximum: 8_000 }),
    why_it_matters: text(item.why_it_matters, `${label}.why_it_matters`, { maximum: 8_000 }),
    impact: text(item.impact, `${label}.impact`, { maximum: 4_000 }),
    ...(resolutionValue === undefined ? {} : { resolution: resolutionValue }),
    ...(bypassValue === undefined ? {} : { bypass: bypassValue }),
    ...(item.reopened_reason === undefined ? {} : { reopened_reason: text(item.reopened_reason, `${label}.reopened_reason`, { maximum: 4_000 }) }),
  };
}

function finalAssessment(value) {
  const item = object(value, "final_assessment");
  exact(item, ASSESSMENT_FIELDS, ASSESSMENT_FIELDS, "final_assessment");
  const boundary = enumValue(item.boundary, BOUNDARIES, "final_assessment.boundary");
  const capabilityCount = integer(item.capability_count, "final_assessment.capability_count", { maximum: 500 });
  const decompositionValue = enumValue(item.decomposition_value, DECOMPOSITION_VALUES, "final_assessment.decomposition_value");
  if (boundary === "UNITARY" && capabilityCount !== 1) throw new ValidationError("UNITARY boundary requires capability_count=1");
  if (boundary === "MULTIPLE" && capabilityCount < 2) throw new ValidationError("MULTIPLE boundary requires at least two capabilities");
  if (boundary === "UNESTABLISHED" && capabilityCount !== 0) throw new ValidationError("UNESTABLISHED boundary requires capability_count=0");
  if (boundary === "AMBIGUOUS" && decompositionValue !== "UNCLEAR") throw new ValidationError("AMBIGUOUS boundary requires decomposition_value=UNCLEAR");
  return {
    boundary,
    capability_count: capabilityCount,
    decomposition_value: decompositionValue,
    rationale: text(item.rationale, "final_assessment.rationale", { maximum: 8_000 }),
  };
}

export function expectedOutcome(model) {
  if (model.findings.some((item) => item.disposition === "open" && item.severity === "BLOCKING")
    || model.final_assessment.boundary === "UNESTABLISHED") return "BLOCKED";
  if (model.final_assessment.boundary === "UNITARY" && model.final_assessment.capability_count === 1
    && model.final_assessment.decomposition_value === "NONE") return "READY_FOR_SPEC";
  return "READY_FOR_ROADMAP";
}

function handoff(value, model, refinementPath) {
  const item = object(value, "handoff");
  exact(item, HANDOFF_FIELDS, HANDOFF_FIELDS, "handoff");
  const outcome = enumValue(item.outcome, OUTCOMES, "handoff.outcome");
  const expected = expectedOutcome(model);
  if (outcome !== expected) throw new ValidationError(`handoff.outcome must be ${expected} for the current authority`);
  const blockerIds = identifierArray(item.blocker_ids, "handoff.blocker_ids", /^FND-[0-9]{3}$/u, { maximum: 1_000 });
  exactIds(blockerIds, model.findings.filter((entry) => entry.disposition === "open" && entry.severity === "BLOCKING").map((entry) => entry.id), "handoff.blocker_ids");
  const carriedExpected = model.findings
    .filter((entry) => entry.disposition === "bypassed" || (entry.disposition === "open" && (outcome === "BLOCKED" || entry.severity !== "BLOCKING")))
    .map((entry) => entry.id);
  const carried = identifierArray(item.carried_finding_ids, "handoff.carried_finding_ids", /^FND-[0-9]{3}$/u, { maximum: 1_000 });
  exactIds(carried, carriedExpected, "handoff.carried_finding_ids");
  const expectedRoute = outcome === "BLOCKED"
    ? ["stnl-requirements-refiner", "OPERATION=RECONCILE", "REFINEMENT"]
    : outcome === "READY_FOR_SPEC"
      ? ["stnl-spec-lifecycle-manager", "MODE=INIT", "SPEC"]
      : ["stnl-spec-roadmap", "OPERATION=INIT", "ROADMAP"];
  if (item.next_workflow !== expectedRoute[0] || item.suggested_next_operation !== expectedRoute[1]) {
    throw new ValidationError(`handoff route must be ${expectedRoute[0]} ${expectedRoute[1]}`);
  }
  const payload = object(item.payload, "handoff.payload");
  exact(payload, PAYLOAD_FIELDS, new Set([
    "kind", "need_ids", "finding_ids", "question_ids", "constraint_ids", "relationship_ids", "evidence_ids",
  ]), "handoff.payload");
  if (payload.kind !== expectedRoute[2]) throw new ValidationError(`handoff.payload.kind must be ${expectedRoute[2]}`);
  const normalized = {
    kind: payload.kind,
    need_ids: identifierArray(payload.need_ids, "handoff.payload.need_ids", /^NEED-[0-9]{3}$/u, { maximum: 2_000 }),
    finding_ids: identifierArray(payload.finding_ids, "handoff.payload.finding_ids", /^FND-[0-9]{3}$/u, { maximum: 1_000 }),
    question_ids: identifierArray(payload.question_ids, "handoff.payload.question_ids", /^QST-[0-9]{3}$/u, { maximum: 1_000 }),
    constraint_ids: identifierArray(payload.constraint_ids, "handoff.payload.constraint_ids", /^CON-[0-9]{3}$/u, { maximum: 1_000 }),
    relationship_ids: identifierArray(payload.relationship_ids, "handoff.payload.relationship_ids", /^REL-[0-9]{3}$/u, { maximum: 1_000 }),
    evidence_ids: identifierArray(payload.evidence_ids, "handoff.payload.evidence_ids", /^EVD-[0-9]{3}$/u, { maximum: 2_000 }),
  };
  exactIds(normalized.need_ids, model.needs.filter((entry) => entry.state === "ACTIVE").map((entry) => entry.id), "handoff.payload.need_ids");
  exactIds(normalized.finding_ids, carriedExpected, "handoff.payload.finding_ids");
  exactIds(normalized.question_ids, model.questions.filter((entry) => entry.status === "OPEN").map((entry) => entry.id), "handoff.payload.question_ids");
  exactIds(normalized.constraint_ids, model.constraints.filter((entry) => entry.state === "ACTIVE").map((entry) => entry.id), "handoff.payload.constraint_ids");
  exactIds(normalized.relationship_ids, model.relationships.filter((entry) => entry.state === "ACTIVE").map((entry) => entry.id), "handoff.payload.relationship_ids");
  exactIds(normalized.evidence_ids, model.evidence.filter((entry) => entry.state === "ACTIVE").map((entry) => entry.id), "handoff.payload.evidence_ids");

  if (outcome === "READY_FOR_SPEC") {
    exact(payload, PAYLOAD_FIELDS, new Set([
      "kind", "need_ids", "finding_ids", "question_ids", "constraint_ids", "relationship_ids", "evidence_ids",
      "suggested_spec_title", "requirements_source",
    ]), "handoff.payload");
    normalized.suggested_spec_title = text(payload.suggested_spec_title, "handoff.payload.suggested_spec_title", { maximum: 500 });
    if (payload.suggested_spec_path !== undefined) {
      normalized.suggested_spec_path = normalizeRelativePath(payload.suggested_spec_path, "handoff.payload.suggested_spec_path");
      const refinementParts = refinementPath.split("/").map(filesystemKey);
      const specParts = normalized.suggested_spec_path.split("/").map(filesystemKey);
      const common = Math.min(refinementParts.length, specParts.length);
      if (refinementParts.slice(0, common).every((part, index) => part === specParts[index])) {
        throw new ValidationError("handoff.payload.suggested_spec_path collides with REFINEMENT_PATH");
      }
    }
    normalized.requirements_source = text(payload.requirements_source, "handoff.payload.requirements_source", { maximum: 100_000 });
  } else if (outcome === "READY_FOR_ROADMAP") {
    exact(payload, PAYLOAD_FIELDS, new Set([
      "kind", "need_ids", "finding_ids", "question_ids", "constraint_ids", "relationship_ids", "evidence_ids", "roadmap_source",
    ]), "handoff.payload");
    normalized.roadmap_source = text(payload.roadmap_source, "handoff.payload.roadmap_source", { maximum: 100_000 });
  } else {
    exact(payload, PAYLOAD_FIELDS, new Set([
      "kind", "need_ids", "finding_ids", "question_ids", "constraint_ids", "relationship_ids", "evidence_ids",
    ]), "handoff.payload");
  }
  return {
    outcome,
    reason: text(item.reason, "handoff.reason", { maximum: 8_000 }),
    blocker_ids: blockerIds,
    carried_finding_ids: carried,
    next_workflow: item.next_workflow,
    suggested_next_operation: item.suggested_next_operation,
    payload: normalized,
  };
}

function requireReferences(model, refinementPath) {
  const maps = {
    sources: new Map(model.sources.map((item) => [item.id, item])),
    needs: new Map(model.needs.map((item) => [item.id, item])),
    evidence: new Map(model.evidence.map((item) => [item.id, item])),
    relationships: new Map(model.relationships.map((item) => [item.id, item])),
    questions: new Map(model.questions.map((item) => [item.id, item])),
    findings: new Map(model.findings.map((item) => [item.id, item])),
  };
  const exists = (collection, ids, label) => {
    for (const id of ids) if (!maps[collection].has(id)) throw new ValidationError(`${label} references missing ${id}`);
  };
  for (const item of model.needs) exists("sources", item.source_ids, item.id);
  for (const item of model.evidence) {
    exists("sources", item.source_ids, item.id);
    exists("needs", item.need_ids, item.id);
    if (item.kind === "REPOSITORY_OBSERVATION" && !model.exploration.files_read.includes(item.path)) {
      throw new ValidationError(`${item.id}.path must be listed in exploration.files_read`);
    }
  }
  for (const item of model.relationships) {
    exists("needs", item.need_ids, item.id);
    exists("evidence", item.evidence_ids, item.id);
  }
  for (const item of model.questions) {
    exists("needs", item.need_ids, item.id);
    exists("findings", item.finding_ids, item.id);
    exists("evidence", item.evidence_ids, item.id);
    for (const findingId of item.finding_ids) {
      if (!maps.findings.get(findingId).question_ids.includes(item.id)) throw new ValidationError(`${item.id} and ${findingId} must reference each other`);
    }
  }
  for (const item of model.constraints) {
    exists("needs", item.need_ids, item.id);
    exists("evidence", item.evidence_ids, item.id);
  }
  for (const item of model.findings) {
    exists("needs", item.need_ids, item.id);
    exists("evidence", item.evidence_ids, item.id);
    exists("relationships", item.relationship_ids, item.id);
    exists("questions", item.question_ids, item.id);
    if (item.resolution !== undefined) exists("evidence", item.resolution.supporting_evidence_ids, `${item.id}.resolution`);
    for (const questionId of item.question_ids) {
      if (!maps.questions.get(questionId).finding_ids.includes(item.id)) throw new ValidationError(`${item.id} and ${questionId} must reference each other`);
    }
    if (item.type === "CROSS_REQUIREMENT_GAP" && item.need_ids.length < 2) {
      throw new ValidationError(`${item.id} cross-requirement gap requires at least two needs`);
    }
    if (item.type === "REPOSITORY_CONFLICT" && !item.evidence_ids.some((id) => maps.evidence.get(id).kind === "REPOSITORY_OBSERVATION")) {
      throw new ValidationError(`${item.id} repository conflict requires repository evidence`);
    }
  }
  if (model.exploration.status === "NOT_NEEDED" && (model.exploration.files_read.length !== 0
    || model.evidence.some((item) => item.kind === "REPOSITORY_OBSERVATION"))) {
    throw new ValidationError("NOT_NEEDED exploration cannot claim repository reads or observations");
  }
  const outputParts = refinementPath.split("/").map(filesystemKey);
  for (const [label, candidate] of [
    ...model.sources.filter((item) => item.path !== undefined).map((item) => [`${item.id}.path`, item.path]),
    ...model.evidence.filter((item) => item.path !== undefined).map((item) => [`${item.id}.path`, item.path]),
    ...model.exploration.files_read.map((item) => ["exploration.files_read", item]),
  ]) {
    const parts = candidate.split("/").map(filesystemKey);
    const common = Math.min(parts.length, outputParts.length);
    if (parts.slice(0, common).every((part, index) => part === outputParts[index]) && parts.length >= outputParts.length) {
      throw new ValidationError(`${label} must not read from REFINEMENT_PATH`);
    }
  }
}

function scanSensitive(value, location = "refinement") {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new ValidationError(`${location} appears to contain a secret or credential`);
    }
    for (const pattern of HOST_PATH_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new ValidationError(`${location} appears to contain an absolute host path`);
    }
    EMAIL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      const domain = match[1].toLowerCase();
      if (!new Set(["example.com", "example.org", "example.net", "test.invalid"]).has(domain)) {
        throw new ValidationError(`${location} appears to contain real PII`);
      }
    }
    if (CPF_PATTERN.test(value)) throw new ValidationError(`${location} appears to contain real PII`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSensitive(entry, `${location}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) scanSensitive(value[key], `${location}.${key}`);
  }
}

export function validateRefinement(raw, { refinementPath = "docs/refinement" } = {}) {
  const root = object(raw, "refinement");
  exact(root, TOP_LEVEL_FIELDS, TOP_LEVEL_FIELDS, "refinement");
  if (root.contract_version !== 1) throw new ValidationError("refinement.contract_version must be 1");
  const partial = {
    contract_version: 1,
    refinement_id: identifier(root.refinement_id, "refinement.refinement_id", /^REF-[A-Z0-9][A-Z0-9-]{0,62}$/u),
    title: text(root.title, "refinement.title", { maximum: 500 }),
    summary: text(root.summary, "refinement.summary", { maximum: 12_000 }),
    input_assessment: inputAssessment(root.input_assessment),
    exploration: exploration(root.exploration),
    sources: array(root.sources, "sources", { minimum: 1, maximum: 200 }).map((item, index) => source(item, `sources[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    needs: array(root.needs, "needs", { minimum: 1, maximum: 2_000 }).map((item, index) => need(item, `needs[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    evidence: array(root.evidence, "evidence", { minimum: 1, maximum: 3_000 }).map((item, index) => evidence(item, `evidence[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    relationships: array(root.relationships, "relationships", { maximum: 2_000 }).map((item, index) => relationship(item, `relationships[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    questions: array(root.questions, "questions", { maximum: 2_000 }).map((item, index) => question(item, `questions[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    constraints: array(root.constraints, "constraints", { maximum: 2_000 }).map((item, index) => constraint(item, `constraints[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    findings: array(root.findings, "findings", { maximum: 2_000 }).map((item, index) => finding(item, `findings[${index}]`)).sort((a, b) => a.id.localeCompare(b.id, "en")),
    final_assessment: finalAssessment(root.final_assessment),
  };
  for (const [items, prefix, label] of [
    [partial.sources, "SRC-", "source"], [partial.needs, "NEED-", "need"], [partial.evidence, "EVD-", "evidence"],
    [partial.relationships, "REL-", "relationship"], [partial.questions, "QST-", "question"],
    [partial.constraints, "CON-", "constraint"], [partial.findings, "FND-", "finding"],
  ]) requireContiguousIds(items, prefix, label);
  requireReferences(partial, refinementPath);
  const normalized = { ...partial, handoff: handoff(root.handoff, partial, refinementPath) };
  scanSensitive(normalized);
  return normalized;
}

function ensurePreserved(before, after, label) {
  const next = new Set(after.map((item) => item.id));
  const missing = before.filter((item) => !next.has(item.id)).map((item) => item.id);
  if (missing.length !== 0) throw new ValidationError(`${label} identities cannot be removed: ${missing.join(", ")}`);
}

function identity(value, fields) {
  return canonicalJson(Object.fromEntries(fields.map((field) => [field, value[field] ?? null])));
}

export function validateReconcile(previous, next) {
  if (previous.refinement_id !== next.refinement_id) throw new ValidationError("RECONCILE cannot change refinement_id");
  for (const [label, before, after] of [
    ["source", previous.sources, next.sources], ["need", previous.needs, next.needs], ["evidence", previous.evidence, next.evidence],
    ["relationship", previous.relationships, next.relationships], ["question", previous.questions, next.questions],
    ["constraint", previous.constraints, next.constraints], ["finding", previous.findings, next.findings],
  ]) ensurePreserved(before, after, label);
  const checks = [
    ["source", previous.sources, next.sources, ["id", "kind", "label", "external_id", "path"]],
    ["need", previous.needs, next.needs, ["id", "title", "source_ids"]],
    ["evidence", previous.evidence, next.evidence, ["id", "kind", "summary", "path", "locator"]],
    ["relationship", previous.relationships, next.relationships, ["id", "type", "title", "need_ids", "from_need_id", "to_need_id"]],
    ["question", previous.questions, next.questions, ["id", "question"]],
    ["constraint", previous.constraints, next.constraints, ["id", "statement"]],
    ["finding", previous.findings, next.findings, ["id", "type", "title", "need_ids"]],
  ];
  for (const [label, beforeItems, afterItems, fields] of checks) {
    const after = new Map(afterItems.map((item) => [item.id, item]));
    for (const before of beforeItems) {
      if (identity(before, fields) !== identity(after.get(before.id), fields)) {
        throw new ValidationError(`${before.id} stable ${label} identity changed; retire it and allocate a new ID`);
      }
    }
  }
  for (const [label, beforeItems, afterItems, stateField, terminal] of [
    ["source", previous.sources, next.sources, "state", "RETIRED"],
    ["need", previous.needs, next.needs, "state", "RETIRED"],
    ["evidence", previous.evidence, next.evidence, "state", "SUPERSEDED"],
    ["relationship", previous.relationships, next.relationships, "state", "RETIRED"],
    ["constraint", previous.constraints, next.constraints, "state", "RETIRED"],
  ]) {
    const after = new Map(afterItems.map((item) => [item.id, item]));
    for (const before of beforeItems.filter((item) => item[stateField] === terminal)) {
      if (canonicalJson(before) !== canonicalJson(after.get(before.id))) throw new ValidationError(`${before.id} is a terminal ${label} tombstone`);
    }
  }
  const nextFindings = new Map(next.findings.map((item) => [item.id, item]));
  for (const before of previous.findings) {
    const after = nextFindings.get(before.id);
    if (before.disposition !== "open" && after.disposition === "open") {
      if (after.reopened_reason === undefined) throw new ValidationError(`${before.id} reopening requires reopened_reason`);
      if (before.resolution?.verdict === "accepted") {
        if (after.resolution?.proposal !== before.resolution.proposal || !new Set(["rejected", "inconclusive"]).has(after.resolution?.verdict)) {
          throw new ValidationError(`${before.id} reopened accepted resolution must preserve its proposal and record a rejected or inconclusive validation`);
        }
      }
    }
  }
  return next;
}

export async function hydrateFingerprints(model, projectRoot) {
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
    sources.push({ ...item, snapshot_sha256: sha256(await fs.readFile(resolved.absolute)) });
  }
  const evidenceItems = [];
  for (const item of model.evidence) {
    if (item.kind !== "REPOSITORY_OBSERVATION") {
      const copy = { ...item };
      delete copy.snapshot_sha256;
      evidenceItems.push(copy);
      continue;
    }
    const resolved = await resolveInsideProject(projectRoot, item.path, `${item.id}.path`);
    await requireSingleLinkRealFile(resolved.absolute, `${item.id} repository evidence`, 5_000_000);
    evidenceItems.push({ ...item, snapshot_sha256: sha256(await fs.readFile(resolved.absolute)) });
  }
  return { ...model, sources, evidence: evidenceItems };
}
