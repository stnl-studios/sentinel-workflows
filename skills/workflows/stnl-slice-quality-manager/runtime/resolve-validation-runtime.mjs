#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VALIDATION_CAPABILITY_IDENTITY,
} from "./validation-capability.mjs";
export { VALIDATION_CAPABILITY_IDENTITY } from "./validation-capability.mjs";
import {
  computeRequirementsAuthority,
  evaluateQualityGate,
  preflightExecutionOperation,
  validateExecutionCandidate,
  validateExecutionCandidateDestination,
} from "./execution-state.mjs";
import {
  ValidationEnvironmentSelectionError,
  discoverValidationEnvironments,
  enforceValidationEnvironmentSelection,
  resolveValidationEnvironmentSelection,
  validateValidationEnvironmentSelection,
} from "./validation-environment-selection.mjs";
export {
  discoverValidationEnvironments,
  resolveValidationEnvironmentSelection,
} from "./validation-environment-selection.mjs";

const VALIDATION_OWNERS = new Set(["stnl-slice-executor", "stnl-slice-quality-manager"]);
const RESOLVER_FILENAME = "resolve-validation-runtime.mjs";
export const VALIDATION_RUNNER_PROTOCOL = "stnl-validation-runner/v11";
export const VALIDATION_HARNESS_PROTOCOL = "stnl-validation-harness/v10";
export const VALIDATION_PLAN_SCHEMA = "stnl-validation-plan/v1";
export const VALIDATION_BRIDGE_RESULT_SCHEMA = "stnl-validation-bridge-result/v1";
export const VALIDATION_ASSESSMENT_SCHEMA = "stnl-validation-assessment/v1";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const PLAN_KEYS = new Set([
  "schema", "protocol", "operation", "slice", "round", "requirementsAuthority", "planRevision",
  "discovery", "cwd", "subjects", "commands", "baselineFingerprint", "failureConclusion",
  "replayOriginEvidenceId", "coverage", "findings", "priorRound", "assessment",
]);
const PLAN_PROTOCOL_KEYS = new Set(["runner", "harness", "capability"]);
const DISCOVERY_KEYS = new Set(["sources", "actions"]);
const COVERAGE_KEYS = new Set([
  "verificationTypes", "selectedChecks", "rationale", "coverage", "filelessReason", "nonApplicabilityRationale",
]);
const COMMAND_KEYS = new Set([
  "argv", "cwd", "writePaths", "writeFiles", "env", "timeoutMs", "environmentScope", "executionEnvironment",
]);
const HOST_ENVIRONMENT_KEYS = new Set(["kind"]);
const COMPOSE_ENVIRONMENT_KEYS = new Set([
  "kind", "composeFile", "service", "image", "authoritySources",
]);
const COMPOSE_CACHE_ENVIRONMENT_KEYS = new Set([...COMPOSE_ENVIRONMENT_KEYS, "cacheVolumes"]);
const CACHE_VOLUME_KEYS = new Set(["source", "target"]);
const FINDINGS_KEYS = new Set(["cycle", "ids", "correctionsCovered", "regressions"]);
const PRIOR_ROUND_KEYS = new Set(["failure", "correction", "paths", "updatedScope", "rationale"]);
const ASSESSMENT_KEYS = new Set([
  "schema", "planIdentity", "evidenceId", "operation", "slice", "round", "status", "evidence",
  "verifiedScope", "findingReferences", "findingDispositions", "blockers", "gates", "manifest",
  "filelessReason", "overlaps", "regressions", "persistenceSummary",
]);
const RESULT_SHAPED_KEYS = new Set([
  "status", "exit", "exits", "count", "testCount", "testsPassed", "provenance", "receipt", "evidenceId", "outputs",
]);
const FORBIDDEN_INFRASTRUCTURE_TEXT = /(?:^|[/\\])(?:resolve-validation-runtime|run-validation-session)\.mjs(?:$|\s)|(?:^|[/\\])(?:\.agents|\.claude)[/\\]skills[/\\]/iu;
const OWNER_OPERATIONS = Object.freeze({
  "stnl-slice-executor": new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]),
  "stnl-slice-quality-manager": new Set(["VALIDATE_SLICE"]),
});

export class ValidationRuntimeResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationRuntimeResolutionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ValidationRuntimeResolutionError(code, message);
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function skillMetadata(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) fail("INVALID_SKILL_METADATA", "owning skill has invalid or missing frontmatter");
  const metadata = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/u.exec(line);
    if (field === null || Object.hasOwn(metadata, field[1])) {
      fail("INVALID_SKILL_METADATA", "owning skill has invalid validation runtime metadata");
    }
    metadata[field[1]] = field[2];
  }
  return metadata;
}

function declaredEntrypoint(metadata) {
  const entrypoint = metadata["validation-runtime"];
  if (typeof entrypoint !== "string" || entrypoint.length === 0 || entrypoint.includes("\\")
    || entrypoint.includes("\0") || path.posix.isAbsolute(entrypoint)
    || path.posix.normalize(entrypoint) !== entrypoint
    || entrypoint === ".." || entrypoint.startsWith("../")) {
    fail("INVALID_VALIDATION_RUNTIME_ENTRYPOINT", "owning skill validation runtime entrypoint is not a canonical relative path");
  }
  return entrypoint;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(domain, value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical([domain, value]))).digest("hex")}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function planFail(code, message) {
  fail(code, `validation plan rejected before harness dispatch: ${message}`);
}

function normalizedRelative(value, label, { allowParent = false } = {}) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.endsWith("/") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || (!allowParent && (value === ".." || value.startsWith("../")))) {
    planFail("INVALID_VALIDATION_PLAN_PATH", `${label} must be a normalized relative path`);
  }
  return value;
}

function nonPlaceholder(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || /^<?(?:none|n\/a|pending|unknown)>?$/iu.test(value.trim())) {
    planFail("INVALID_VALIDATION_PLAN_TEXT", `${label} must be non-placeholder text`);
  }
  return value.trim();
}

function uniqueTextArray(value, label, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum
    || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    planFail("INVALID_VALIDATION_PLAN", `${label} must be an array of non-empty strings`);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) {
    planFail("INVALID_VALIDATION_PLAN", `${label} must be unique`);
  }
  return Object.freeze(normalized);
}

function rejectInfrastructureDisclosure(value, label = "validation plan") {
  if (typeof value === "string") {
    if (FORBIDDEN_INFRASTRUCTURE_TEXT.test(value)) {
      planFail("VALIDATION_PLAN_INFRASTRUCTURE_PATH_FORBIDDEN", `${label} exposes packaged validation infrastructure`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectInfrastructureDisclosure(entry, `${label}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:skillRoot|runtimePath|harnessPath|resolverPath|installationRoot)$/iu.test(key)) {
        planFail("VALIDATION_PLAN_INFRASTRUCTURE_PATH_FORBIDDEN", `${label} contains forbidden infrastructure field ${key}`);
      }
      rejectInfrastructureDisclosure(entry, `${label}.${key}`);
    }
  }
}

function validateExecutionEnvironment(value, label) {
  if (value?.kind === "host") {
    if (!exactKeys(value, HOST_ENVIRONMENT_KEYS)) {
      planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} host executionEnvironment has unknown fields`);
    }
    return Object.freeze({ kind: "host" });
  }
  if (value?.kind !== "docker-compose") {
    planFail("PLAN_EXECUTION_ENVIRONMENT_REQUIRED", `${label} must declare executionEnvironment without host fallback`);
  }
  const keys = Object.hasOwn(value, "cacheVolumes") ? COMPOSE_CACHE_ENVIRONMENT_KEYS : COMPOSE_ENVIRONMENT_KEYS;
  if (!exactKeys(value, keys)) {
    planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} docker-compose executionEnvironment has missing or unknown fields`);
  }
  const composeFile = normalizedRelative(value.composeFile, `${label} composeFile`);
  if (!new Set(["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]).has(path.posix.basename(composeFile))
    || typeof value.service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.service)
    || typeof value.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(value.image)
    || value.image.includes("..") || value.image.endsWith("/") || value.image.endsWith(":")) {
    planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} docker-compose identity is malformed`);
  }
  const authoritySources = uniqueTextArray(value.authoritySources, `${label} authoritySources`, { minimum: 1 })
    .map((entry) => normalizedRelative(entry, `${label} authority source`))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(authoritySources).size !== authoritySources.length || authoritySources.includes(composeFile)) {
    planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} authoritySources must be unique and separate from the Compose file`);
  }
  const output = { kind: "docker-compose", composeFile, service: value.service, image: value.image, authoritySources };
  if (Object.hasOwn(value, "cacheVolumes")) {
    if (!Array.isArray(value.cacheVolumes) || value.cacheVolumes.length === 0) {
      planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} cacheVolumes must be non-empty when present`);
    }
    output.cacheVolumes = value.cacheVolumes.map((entry, index) => {
      if (!exactKeys(entry, CACHE_VOLUME_KEYS)
        || typeof entry.source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(entry.source)
        || typeof entry.target !== "string" || !path.posix.isAbsolute(entry.target)
        || path.posix.normalize(entry.target) !== entry.target || entry.target === "/") {
        planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} cache volume ${index + 1} is malformed`);
      }
      return Object.freeze({ source: entry.source, target: entry.target });
    });
  }
  return Object.freeze(output);
}

function validatePlanCommand(command, index) {
  const label = `validation plan command ${index + 1}`;
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    planFail("INVALID_VALIDATION_PLAN_COMMAND", `${label} must be an object`);
  }
  if (!Object.hasOwn(command, "executionEnvironment")) {
    planFail("PLAN_EXECUTION_ENVIRONMENT_REQUIRED", `${label} omits executionEnvironment; host inference is forbidden`);
  }
  if (!exactKeys(command, COMMAND_KEYS)) {
    planFail("INVALID_VALIDATION_PLAN_COMMAND", `${label} has missing or unknown fields`);
  }
  if (!Array.isArray(command.argv) || command.argv.length === 0
    || command.argv.some((entry) => typeof entry !== "string" || entry.length === 0)
    || path.posix.isAbsolute(command.argv[0]) || path.win32.isAbsolute(command.argv[0])
    || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) {
    planFail("INVALID_VALIDATION_PLAN_COMMAND", `${label} must carry logical argv and a positive timeout`);
  }
  if (typeof command.environmentScope !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(command.environmentScope)) {
    planFail("INVALID_VALIDATION_PLAN_ENVIRONMENT", `${label} environmentScope is malformed`);
  }
  const cwd = normalizedRelative(command.cwd, `${label} cwd`);
  const writePaths = uniqueTextArray(command.writePaths, `${label} writePaths`)
    .map((entry) => normalizedRelative(entry, `${label} write path`)).sort((left, right) => left.localeCompare(right, "en"));
  const writeFiles = uniqueTextArray(command.writeFiles, `${label} writeFiles`)
    .map((entry) => normalizedRelative(entry, `${label} write file`)).sort((left, right) => left.localeCompare(right, "en"));
  if (writePaths.includes(".") || writeFiles.includes(".")
    || writeFiles.some((entry) => writePaths.some((directory) => entry === directory || entry.startsWith(`${directory}/`)))) {
    planFail("INVALID_VALIDATION_PLAN_COMMAND", `${label} writable outputs are not bounded`);
  }
  if (command.env === null || typeof command.env !== "object" || Array.isArray(command.env)
    || Object.entries(command.env).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string")) {
    planFail("INVALID_VALIDATION_PLAN_COMMAND", `${label} env is malformed`);
  }
  return Object.freeze({
    argv: Object.freeze([...command.argv]), cwd,
    writePaths: Object.freeze(writePaths), writeFiles: Object.freeze(writeFiles),
    env: Object.freeze({ ...command.env }), timeoutMs: command.timeoutMs,
    environmentScope: command.environmentScope,
    executionEnvironment: validateExecutionEnvironment(command.executionEnvironment, label),
  });
}

function currentInvocation(task, operation) {
  if (operation === "VALIDATE_SLICE") {
    const previous = task.attempts.at(-1) ?? null;
    if (previous !== null && new Set(["PASS", "ACCEPTED"]).has(previous.status)) return null;
    return { round: null, priorEvidenceId: previous?.provenance?.evidenceId ?? null };
  }
  const records = operation === "EXECUTE_SLICE" ? task.implementationChecks : task.findingsChecks;
  let cycleRecords = records;
  if (operation === "APPLY_FINDINGS") {
    const cycle = task.attempts.at(-1)?.id ?? null;
    if (cycle === null) return null;
    cycleRecords = records.filter((record) => record.findingsCycle === cycle);
  }
  const previous = cycleRecords.at(-1) ?? null;
  let round = "1/3";
  if (previous?.status === "TESTS_FAIL" && previous.round < 3) round = `${previous.round + 1}/3`;
  else if (previous?.status === "BLOCKED") round = `${previous.round}/3`;
  else if (previous !== null) return null;
  if (task.delegationBlocker?.state === "active" && task.delegationBlocker.operation === operation
    && task.delegationBlocker.pendingRound !== null) round = `${task.delegationBlocker.pendingRound}/3`;
  return { round, priorEvidenceId: records.at(-1)?.provenance?.evidenceId ?? null };
}

function validateFindingsPlan(value, operation, task) {
  if (operation !== "APPLY_FINDINGS") {
    if (value !== null) planFail("INVALID_VALIDATION_PLAN_FINDINGS", `${operation} plan must use findings:null`);
    return null;
  }
  if (!exactKeys(value, FINDINGS_KEYS) || !/^attempt-[0-9]{2,}$/u.test(value.cycle)) {
    planFail("INVALID_VALIDATION_PLAN_FINDINGS", "APPLY_FINDINGS plan has malformed finding context");
  }
  const ids = uniqueTextArray(value.ids, "validation plan finding IDs", { minimum: 1 }).sort((a, b) => a.localeCompare(b, "en"));
  const active = new Set(task.findings.filter((entry) => entry.state === "active").map((entry) => entry.id));
  if (task.attempts.at(-1)?.id !== value.cycle || ids.some((identifier) => !active.has(identifier))) {
    planFail("VALIDATION_PLAN_FINDINGS_STALE", "finding cycle or IDs differ from current lifecycle state");
  }
  return Object.freeze({
    cycle: value.cycle, ids: Object.freeze(ids),
    correctionsCovered: nonPlaceholder(value.correctionsCovered, "validation plan correctionsCovered"),
    regressions: nonPlaceholder(value.regressions, "validation plan regressions"),
  });
}

function validatePriorRound(value, round) {
  if (round === null || round === "1/3") {
    if (value !== null) planFail("INVALID_VALIDATION_PLAN_ROUND", "first or formal invocation must use priorRound:null");
    return null;
  }
  if (!exactKeys(value, PRIOR_ROUND_KEYS)) {
    planFail("INVALID_VALIDATION_PLAN_ROUND", "later automatic round requires exact priorRound context");
  }
  const paths = uniqueTextArray(value.paths, "validation plan priorRound paths")
    .map((entry) => normalizedRelative(entry, "validation plan priorRound path", { allowParent: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({
    failure: nonPlaceholder(value.failure, "validation plan priorRound failure"),
    correction: nonPlaceholder(value.correction, "validation plan priorRound correction"),
    paths: Object.freeze(paths),
    updatedScope: nonPlaceholder(value.updatedScope, "validation plan priorRound updatedScope"),
    rationale: nonPlaceholder(value.rationale, "validation plan priorRound rationale"),
  });
}

export async function validateValidationPlan(specPath, value, { resolved = null, environmentSelection = null } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    planFail("INVALID_VALIDATION_PLAN", "planner output must be one structured plan object");
  }
  const resultKeys = Object.keys(value).filter((key) => RESULT_SHAPED_KEYS.has(key));
  if (resultKeys.length !== 0) {
    planFail("RUNNER_RESULT_INSTEAD_OF_PLAN", `planner output contains result-shaped fields: ${resultKeys.sort().join(",")}`);
  }
  if (!exactKeys(value, PLAN_KEYS) || value.schema !== VALIDATION_PLAN_SCHEMA) {
    planFail("INVALID_VALIDATION_PLAN", `planner output must match ${VALIDATION_PLAN_SCHEMA} exactly`);
  }
  rejectInfrastructureDisclosure(value);
  if (!exactKeys(value.protocol, PLAN_PROTOCOL_KEYS)
    || value.protocol.runner !== VALIDATION_RUNNER_PROTOCOL
    || value.protocol.harness !== VALIDATION_HARNESS_PROTOCOL
    || value.protocol.capability !== VALIDATION_CAPABILITY_IDENTITY) {
    planFail("VALIDATION_PLAN_IDENTITY_MISMATCH", "loaded planner protocol/capability is stale or incompatible");
  }
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]).has(value.operation)
    || !/^slice-(?:[0-9]{2}|[1-9][0-9]{2,})$/u.test(value.slice)) {
    planFail("INVALID_VALIDATION_PLAN_OPERATION", "operation or slice is invalid");
  }
  const owner = resolved ?? await resolveOwnValidationRuntime();
  if (!OWNER_OPERATIONS[owner.skillName]?.has(value.operation)) {
    planFail("VALIDATION_PLAN_OWNER_MISMATCH", `${owner.skillName} does not own ${value.operation}`);
  }
  const preflight = await preflightExecutionOperation(specPath, value.operation, String(Number.parseInt(value.slice.slice("slice-".length), 10)));
  const task = preflight.tasks.get(value.slice);
  const expected = currentInvocation(task, value.operation);
  if (expected === null || value.round !== expected.round) {
    planFail("VALIDATION_PLAN_ROUND_MISMATCH", "plan round differs from the current legal invocation");
  }
  const authority = `sha256:${await computeRequirementsAuthority(specPath)}`;
  if (value.requirementsAuthority !== authority || value.planRevision !== task.revision) {
    planFail("VALIDATION_PLAN_AUTHORITY_MISMATCH", "requirements authority or plan revision is stale");
  }
  if (!exactKeys(value.discovery, DISCOVERY_KEYS)) {
    planFail("INVALID_VALIDATION_PLAN_DISCOVERY", "discovery must contain exact sources/actions fields");
  }
  const discovery = Object.freeze({
    sources: uniqueTextArray(value.discovery.sources, "validation plan discovery sources", { minimum: 1 }),
    actions: uniqueTextArray(value.discovery.actions, "validation plan discovery actions", { minimum: 1 }),
  });
  const cwd = normalizedRelative(value.cwd, "validation plan cwd");
  const subjects = uniqueTextArray(value.subjects, "validation plan subjects")
    .map((entry) => normalizedRelative(entry, "validation plan subject", { allowParent: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const subjectClaims = new Set(task.claims);
  const unexpectedSubjects = subjects.filter((entry) => !subjectClaims.has(entry));
  if (unexpectedSubjects.length !== 0) {
    planFail(
      "VALIDATION_PLAN_SUBJECT_BASE_MISMATCH",
      `subjects must use the task-relative Changed Areas base: ${unexpectedSubjects.join(", ")}`,
    );
  }
  if (!Array.isArray(value.commands)) planFail("INVALID_VALIDATION_PLAN_COMMAND", "commands must be an array");
  const commands = Object.freeze(value.commands.map(validatePlanCommand));
  if (value.baselineFingerprint !== null && !HASH.test(value.baselineFingerprint)) {
    planFail("INVALID_VALIDATION_PLAN", "baselineFingerprint is malformed");
  }
  if (value.replayOriginEvidenceId !== null && !HASH.test(value.replayOriginEvidenceId)) {
    planFail("INVALID_VALIDATION_PLAN", "replayOriginEvidenceId is malformed");
  }
  if (!new Set(["NONE", "VALIDATION_FINDING", "CODE_REGRESSION"]).has(value.failureConclusion)
    || (value.failureConclusion === "CODE_REGRESSION") !== (value.replayOriginEvidenceId !== null)) {
    planFail("INVALID_VALIDATION_PLAN", "failureConclusion/replay policy is invalid");
  }
  if (!exactKeys(value.coverage, COVERAGE_KEYS)) {
    planFail("INVALID_VALIDATION_PLAN_COVERAGE", "coverage has missing or unknown fields");
  }
  const coverage = Object.freeze({
    verificationTypes: nonPlaceholder(value.coverage.verificationTypes, "validation plan verificationTypes"),
    selectedChecks: nonPlaceholder(value.coverage.selectedChecks, "validation plan selectedChecks"),
    rationale: nonPlaceholder(value.coverage.rationale, "validation plan rationale"),
    coverage: nonPlaceholder(value.coverage.coverage, "validation plan coverage"),
    filelessReason: value.coverage.filelessReason === null ? null
      : nonPlaceholder(value.coverage.filelessReason, "validation plan filelessReason"),
    nonApplicabilityRationale: value.coverage.nonApplicabilityRationale === null ? null
      : nonPlaceholder(value.coverage.nonApplicabilityRationale, "validation plan nonApplicabilityRationale"),
  });
  if ((subjects.length === 0) !== (coverage.filelessReason !== null)) {
    planFail("INVALID_VALIDATION_PLAN_COVERAGE", "filelessReason must exist exactly when subjects are empty");
  }
  if ((commands.length === 0) !== (coverage.nonApplicabilityRationale !== null)) {
    planFail("EMPTY_VALIDATION_PLAN", "an empty command plan requires an explicit non-applicability rationale and an executable plan forbids it");
  }
  if (!new Set(["none", "independent"]).has(value.assessment)
    || (value.operation === "VALIDATE_SLICE" && value.assessment !== "independent")) {
    planFail("INVALID_VALIDATION_PLAN_ASSESSMENT", "formal validation requires independent post-harness assessment");
  }
  const selection = await validateValidationEnvironmentSelection(specPath, environmentSelection);
  enforceValidationEnvironmentSelection({ commands, discovery }, selection);
  return Object.freeze({
    schema: value.schema, protocol: Object.freeze({ ...value.protocol }), operation: value.operation,
    slice: value.slice, round: value.round, requirementsAuthority: value.requirementsAuthority,
    planRevision: value.planRevision, discovery, cwd, subjects: Object.freeze(subjects), commands,
    baselineFingerprint: value.baselineFingerprint, failureConclusion: value.failureConclusion,
    replayOriginEvidenceId: value.replayOriginEvidenceId, coverage,
    findings: validateFindingsPlan(value.findings, value.operation, task),
    priorRound: validatePriorRound(value.priorRound, value.round), assessment: value.assessment,
    priorEvidenceId: expected.priorEvidenceId, task, preflight, environmentSelection: selection,
  });
}

async function runtimeProtocolHandshake(runtimePath) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtimePath, "--capabilities"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : signal === null ? 1 : 128,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  let capability;
  try { capability = JSON.parse(result.stdout); } catch { capability = null; }
  if (![0, 1].includes(result.code) || result.stderr !== "" || result.stdout.length > 1024
    || capability === null || typeof capability !== "object" || Array.isArray(capability)
    || !exactKeys(capability, new Set(["runner", "harness", "capability", "packageIdentity", "packageCoherent"]))
    || capability.runner !== VALIDATION_RUNNER_PROTOCOL
    || capability.harness !== VALIDATION_HARNESS_PROTOCOL
    || capability.capability !== VALIDATION_CAPABILITY_IDENTITY
    || typeof capability.packageCoherent !== "boolean"
    || capability.packageCoherent !== (result.code === 0)
    || (capability.packageIdentity !== null
      && (typeof capability.packageIdentity !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(capability.packageIdentity))) ) {
    fail("INCOMPATIBLE_VALIDATION_PROTOCOL", "packaged validation runtime failed the v10 protocol handshake");
  }
  return Object.freeze(capability);
}

export async function resolveOwnValidationRuntime(...callerArguments) {
  if (callerArguments.length !== 0) {
    fail("CALLER_RUNTIME_PATH_FORBIDDEN", "validation runtime resolution accepts no caller-supplied path or root");
  }
  const loadedModule = fileURLToPath(import.meta.url);
  const canonicalModule = await fs.realpath(loadedModule).catch(() => (
    fail("RESOLVER_LOCATION_UNAVAILABLE", "loaded validation runtime resolver location is unavailable")
  ));
  const runtimeRoot = path.dirname(canonicalModule);
  if (path.basename(canonicalModule) !== RESOLVER_FILENAME || path.basename(runtimeRoot) !== "runtime") {
    fail("INVALID_RESOLVER_LOCATION", "loaded validation runtime resolver is outside its packaged runtime directory");
  }
  const skillRoot = await fs.realpath(path.dirname(runtimeRoot)).catch(() => (
    fail("SKILL_LOCATION_UNAVAILABLE", "owning skill location is unavailable")
  ));
  if (!within(canonicalModule, skillRoot)) {
    fail("RESOLVER_ESCAPE", "loaded validation runtime resolver escapes its owning skill package");
  }
  const skillFile = path.join(skillRoot, "SKILL.md");
  const skillFileMetadata = await lstatOrNull(skillFile);
  if (skillFileMetadata === null || skillFileMetadata.isSymbolicLink() || !skillFileMetadata.isFile()) {
    fail("INVALID_SKILL_LOCATION", "owning skill package lacks a real SKILL.md");
  }
  const metadata = skillMetadata(await fs.readFile(skillFile, "utf8"));
  const skillName = path.basename(skillRoot);
  if (!VALIDATION_OWNERS.has(skillName) || metadata.name !== skillName) {
    fail("INVALID_SKILL_OWNER", "loaded package is not a canonical validation-owning skill");
  }
  if (metadata["validation-runner-protocol"] !== VALIDATION_RUNNER_PROTOCOL
    || metadata["validation-harness-protocol"] !== VALIDATION_HARNESS_PROTOCOL) {
    fail("INCOMPATIBLE_VALIDATION_PROTOCOL", "owning skill does not declare the canonical validation runner and harness protocols");
  }
  const entrypoint = declaredEntrypoint(metadata);
  const requestedRuntime = path.resolve(skillRoot, ...entrypoint.split("/"));
  if (!within(requestedRuntime, skillRoot)) {
    fail("VALIDATION_RUNTIME_ESCAPE", "declared validation runtime escapes its owning skill package");
  }
  const requestedMetadata = await lstatOrNull(requestedRuntime);
  if (requestedMetadata === null) {
    fail("VALIDATION_RUNTIME_MISSING", "declared validation runtime is missing from its owning skill package");
  }
  const canonicalRuntime = await fs.realpath(requestedRuntime).catch(() => (
    fail("VALIDATION_RUNTIME_UNRESOLVED", "declared validation runtime cannot be resolved")
  ));
  if (!within(canonicalRuntime, skillRoot)) {
    fail("VALIDATION_RUNTIME_ESCAPE", "declared validation runtime resolves outside its owning skill package");
  }
  if (requestedMetadata.isSymbolicLink()) {
    fail("VALIDATION_RUNTIME_SYMLINK", "declared validation runtime must not be a symbolic link");
  }
  const runtimeMetadata = await fs.stat(canonicalRuntime);
  if (!runtimeMetadata.isFile() || runtimeMetadata.nlink !== 1) {
    fail("INVALID_VALIDATION_RUNTIME", "declared validation runtime must be a single-link regular file");
  }
  const packageCapability = await runtimeProtocolHandshake(canonicalRuntime);
  return Object.freeze({
    skillName, skillRoot, entrypoint, runtimePath: canonicalRuntime,
    runnerProtocol: VALIDATION_RUNNER_PROTOCOL, harnessProtocol: VALIDATION_HARNESS_PROTOCOL,
    capabilityIdentity: VALIDATION_CAPABILITY_IDENTITY,
    packageIdentity: packageCapability.packageIdentity,
    packageCoherent: packageCapability.packageCoherent,
  });
}

export function validationResultTransport(stdout, code, stderr) {
  if (![0, 1].includes(code) || stderr !== "" || stdout.length === 0 || stdout.length > 2_097_152
    || !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) return null;
  let result;
  try { result = JSON.parse(stdout); } catch { return null; }
  if (!exactKeys(result, new Set(["provenance", "outputs"])) || !Array.isArray(result.outputs)) return null;
  const provenance = result.provenance;
  if (provenance?.protocol?.runner !== VALIDATION_RUNNER_PROTOCOL
    || provenance?.protocol?.harness !== VALIDATION_HARNESS_PROTOCOL
    || provenance?.protocol?.capability !== VALIDATION_CAPABILITY_IDENTITY
    || typeof provenance?.receipt !== "string" || typeof provenance?.evidenceId !== "string") return null;
  const { evidenceId: _evidenceId, receipt: _receipt, ...receiptMaterial } = provenance;
  if (provenance.receipt !== digest("stnl-validation-harness-receipt-v10", receiptMaterial)) return null;
  const { evidenceId: _ignored, ...evidenceMaterial } = provenance;
  if (provenance.evidenceId !== digest("stnl-validation-evidence-v10", evidenceMaterial)) return null;
  if ((provenance.state === "INVALID") !== (code === 1)) return null;
  return `stnl-validation-result/v1:${Buffer.from(stdout, "utf8").toString("base64url")}`;
}

function transportedValidationResult(transport) {
  const encoded = transport.slice("stnl-validation-result/v1:".length);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function invokeValidationRuntime(resolved, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolved.runtimePath, ...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const exit = Number.isInteger(code) ? code : signal === null ? 1 : 128;
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      const transport = validationResultTransport(output, exit, errors);
      if (transport === null) {
        resolve(Object.freeze({ exit: 1, transport: null, errors }));
        return;
      }
      resolve(Object.freeze({ exit, transport, errors: "" }));
    });
  });
}

function bridgeStatus(plan, provenance) {
  if (provenance.state === "INVALID" && provenance.workspace.kind === "pre-check") return "BLOCKED";
  if (plan.assessment === "independent" || plan.operation === "VALIDATE_SLICE") return "ASSESSMENT_REQUIRED";
  if (provenance.state === "INVALID") return "BLOCKED";
  if (provenance.commands.length === 0) return "TESTS_NOT_APPLICABLE";
  if (provenance.commands.every((command) => command.exit === 0)) return "TESTS_PASS";
  return provenance.conclusion === "NONE" ? "BLOCKED" : "TESTS_FAIL";
}

function commandLines(provenance) {
  if (provenance.commands.length === 0) return "- Commands: none";
  return `- Commands:\n${provenance.commands.map((command) => `  - \`${command.display}\` | exit:${command.exit}`).join("\n")}`;
}

function testedStateLines(provenance, filelessReason) {
  if (provenance.subjects.length === 0) {
    return `- Tested state: none\n- Fileless reason: ${filelessReason}`;
  }
  return `- Tested state:\n${provenance.subjects.map((subject) => `  - \`${subject.path}\` | ${subject.expected}`).join("\n")}`;
}

function auxiliaryRecord(plan, provenance, transport, status, task, gates = []) {
  const records = plan.operation === "EXECUTE_SLICE" ? task.implementationChecks : task.findingsChecks;
  const prefix = plan.operation === "EXECUTE_SLICE" ? "implementation-check" : "findings-check";
  const recordId = `${prefix}-${String(records.length + 1).padStart(2, "0")}`;
  const failed = provenance.commands.filter((command) => command.exit !== 0);
  const blocker = provenance.blocker === undefined
    ? status === "BLOCKED" ? "executed evidence requires independent classification before a material verdict" : "none"
    : `${provenance.blocker.code}: ${provenance.blocker.message}`;
  const common = [
    `### ${recordId}`,
    "",
    `- Automatic check round: ${plan.round}`,
    `- Status: ${status}`,
    `- HEAD: ${provenance.inputs.head}`,
    `- Tested scope: ${provenance.subjects.map((subject) => subject.path).join(", ") || plan.coverage.filelessReason}`,
    testedStateLines(provenance, plan.coverage.filelessReason),
    `- Discovery sources: ${plan.discovery.sources.join(", ")}`,
    `- Discovery actions: ${plan.discovery.actions.join(", ")}`,
    `- Verification types considered: ${plan.coverage.verificationTypes}`,
    commandLines(provenance),
    `- Evidence provenance: ${transport}`,
    `- Selected checks: ${plan.coverage.selectedChecks}`,
    `- Selection rationale: ${plan.coverage.rationale}`,
    `- Coverage: ${plan.coverage.coverage}`,
  ];
  if (plan.operation === "APPLY_FINDINGS") {
    common.splice(3, 0,
      `- Findings cycle: ${plan.findings.cycle}`,
      `- Finding IDs: ${plan.findings.ids.join(", ")}`,
    );
  }
  common.push(`- Failures: ${failed.length === 0 ? "none" : failed.map((command) => `${command.display} exit ${command.exit}`).join(", ")}`);
  if (plan.operation === "APPLY_FINDINGS") {
    common.push(
      `- Findings verified: ${status === "TESTS_PASS" || status === "TESTS_NOT_APPLICABLE" ? plan.findings.ids.join(", ") : "none"}`,
      `- Corrections covered: ${plan.findings.correctionsCovered}`,
      `- Regressions: ${plan.findings.regressions}`,
      `- Unsupported active findings: ${status === "TESTS_PASS" || status === "TESTS_NOT_APPLICABLE" ? "none" : plan.findings.ids.join(", ")}`,
    );
  }
  common.push(
    `- Blockers: ${blocker}`,
    `- Unexpected workspace effects: ${provenance.workspace.sideEffects.join(", ") || "none"}`,
    ...(gates.length === 0 ? [] : [`- Gate assessments: ${JSON.stringify(gates)}`]),
    `- Persistence summary: ${status} derived by the installed validation bridge from sealed harness evidence.`,
  );
  if (status === "TESTS_NOT_APPLICABLE") {
    common.splice(common.findIndex((line) => line.startsWith("- Commands:")), 0,
      `- Non-applicability rationale: ${plan.coverage.nonApplicabilityRationale}`,
      "- No verification-command confirmation: planner selected no verification command and harness executed none",
    );
  }
  if (plan.priorRound !== null) {
    common.push(
      `- Prior-round failure: ${plan.priorRound.failure}`,
      `- Correction applied: ${plan.priorRound.correction}`,
      `- Correction paths: ${plan.priorRound.paths.join(", ") || "none"}`,
      `- Updated scope: ${plan.priorRound.updatedScope}`,
      `- In-slice rationale: ${plan.priorRound.rationale}`,
    );
  }
  return Object.freeze({ recordId, section: plan.operation === "EXECUTE_SLICE" ? "Implementation Test Evidence" : "Findings Test Evidence", markdown: common.join("\n") });
}

function infrastructureDelegationBlocker(plan, provenance, transport, task) {
  const records = plan.operation === "EXECUTE_SLICE" ? task.implementationChecks
    : plan.operation === "APPLY_FINDINGS" ? task.findingsChecks : task.attempts;
  const after = records.at(-1)?.id ?? "none";
  const cause = `${provenance.blocker.code}: ${provenance.blocker.message}`;
  if (task.delegationBlocker?.state === "active") {
    const evidenceIds = [task.delegationBlocker.provenance, ...task.delegationBlocker.observations]
      .filter((entry) => entry !== null).map((entry) => entry.provenance?.evidenceId ?? entry.evidenceId);
    if (evidenceIds.includes(provenance.evidenceId)) {
      return Object.freeze({
        recordId: "Delegation Blocker", section: "Delegation Blocker",
        episodeId: task.delegationBlocker.id, unchanged: true,
      });
    }
    return Object.freeze({
      recordId: "Delegation Blocker",
      section: "Delegation Blocker",
      episodeId: task.delegationBlocker.id,
      observation: JSON.stringify({ cause, evidence: transport, head: provenance.inputs.head }),
    });
  }
  return Object.freeze({
    recordId: "Delegation Blocker",
    section: "Delegation Blocker",
    episodeId: `delegation-blocker-${String(task.delegationBlockers.length + 1).padStart(2, "0")}`,
    markdown: `- Operation: ${plan.operation}\n- Kind: infrastructure\n- State: active\n- After record: ${after}${plan.round === null ? "" : `\n- Pending automatic round: ${plan.round}`}\n- HEAD: ${provenance.inputs.head}\n- Evidence provenance: ${transport}\n- Causes:\n  - ${cause}\n- Required action: restore the trusted validation infrastructure and resume the same logical planner invocation`,
  });
}

const DIAGNOSTIC_OUTPUT_LIMIT = 2048;

function redactDiagnosticText(value, secrets) {
  let text = String(value).replace(/\r\n?/gu, "\n")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/giu, "[redacted private key]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/giu, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [redacted]");
  let redacted = text !== value;
  for (const secret of [...secrets].filter((entry) => entry.length !== 0).sort((left, right) => right.length - left.length)) {
    if (!text.includes(secret)) continue;
    text = text.replaceAll(secret, "[redacted known secret]");
    redacted = true;
  }
  return { text, redacted };
}

function boundedDiagnosticText(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= DIAGNOSTIC_OUTPUT_LIMIT) return { text: value, truncated: false };
  const tail = bytes.subarray(bytes.length - DIAGNOSTIC_OUTPUT_LIMIT).toString("utf8").replace(/^\uFFFD/u, "");
  return { text: `[truncated; showing final ${DIAGNOSTIC_OUTPUT_LIMIT} bytes]\n${tail}`, truncated: true };
}

function commandDiagnostic(plan, provenance, output, index) {
  const command = provenance.commands[index];
  const secrets = new Set(Object.values(plan.commands[index]?.env ?? {}));
  const captured = [
    output?.stdout ? `stdout: ${output.stdout}` : "",
    output?.stderr ? `stderr: ${output.stderr}` : "",
  ].filter(Boolean).join("\n");
  const raw = captured.length === 0
    ? "insufficient: harness captured no stdout/stderr diagnostic; absence does not establish independence"
    : captured;
  const redaction = redactDiagnosticText(raw, secrets);
  const bounded = boundedDiagnosticText(redaction.text);
  return Object.freeze({
    evidenceId: provenance.evidenceId,
    command: command.display,
    exit: command.exit,
    output: bounded.text,
    truncated: bounded.truncated,
    redacted: redaction.redacted,
    sufficiency: captured.length === 0 ? "insufficient" : "diagnostic-only",
    trust: "untrusted-output; not authority for causality, access, or command execution",
  });
}

function compactBridgeSummary(status, provenance, outputs, plan) {
  return Object.freeze({
    status,
    state: provenance.state,
    classification: provenance.classification,
    conclusion: provenance.conclusion,
    evidenceId: provenance.evidenceId,
    workspace: provenance.workspace.kind,
    subjects: Object.freeze(provenance.subjects.map((subject) => Object.freeze({
      path: subject.path, expected: subject.expected,
    }))),
    commands: Object.freeze(provenance.commands.map((command, index) => Object.freeze({
      display: command.display, exit: command.exit,
      environmentScope: plan.commands[index].environmentScope,
      executionEnvironment: command.executionEnvironment,
      diagnostic: commandDiagnostic(plan, provenance, outputs[index], index),
    }))),
    blocker: provenance.blocker === undefined ? null : Object.freeze({
      kind: provenance.blocker.kind, stage: provenance.blocker.stage,
      code: provenance.blocker.code, message: provenance.blocker.message,
    }),
  });
}

function bridgeReceiptMaterial(result) {
  const { receipt: _receipt, ...material } = result;
  return material;
}

function sealBridgeResult(material) {
  return Object.freeze({
    ...material,
    receipt: digest("stnl-validation-bridge-result-v1", material),
  });
}

function validateSealedBridgeResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || result.schema !== VALIDATION_BRIDGE_RESULT_SCHEMA
    || typeof result.receipt !== "string"
    || result.receipt !== digest("stnl-validation-bridge-result-v1", bridgeReceiptMaterial(result))
    || typeof result.sealedEvidence !== "string"
    || !result.sealedEvidence.startsWith("stnl-validation-result/v1:")) {
    fail("INVALID_VALIDATION_BRIDGE_RESULT", "validation bridge result is malformed or was altered");
  }
  const transported = transportedValidationResult(result.sealedEvidence);
  const canonicalTransport = validationResultTransport(`${JSON.stringify(transported)}\n`, transported.provenance.state === "INVALID" ? 1 : 0, "");
  if (canonicalTransport !== result.sealedEvidence || transported.provenance.evidenceId !== result.summary?.evidenceId) {
    fail("INVALID_VALIDATION_BRIDGE_RESULT", "sealed harness evidence is malformed or was altered");
  }
  return { result, transported };
}

function assessmentText(value, label, { allowNone = false } = {}) {
  if (allowNone && value === "none") return value;
  return nonPlaceholder(value, label);
}

export function validateValidationAssessment(bridgeResult, value) {
  const { result, transported } = validateSealedBridgeResult(bridgeResult);
  if (result.summary.status !== "ASSESSMENT_REQUIRED") {
    fail("UNEXPECTED_VALIDATION_ASSESSMENT", "bridge result does not require an independent assessment");
  }
  if (!exactKeys(value, ASSESSMENT_KEYS) || value.schema !== VALIDATION_ASSESSMENT_SCHEMA
    || value.planIdentity !== result.planIdentity || value.evidenceId !== result.summary.evidenceId
    || value.operation !== result.operation || value.slice !== result.slice || value.round !== result.round) {
    fail("INVALID_VALIDATION_ASSESSMENT", "assessment identity or schema differs from the sealed bridge result");
  }
  const formal = result.operation === "VALIDATE_SLICE";
  const allowed = formal
    ? new Set(["PASS", "ACCEPTED", "NEEDS_FIX", "BLOCKED"])
    : new Set(["TESTS_PASS", "TESTS_ACCEPTED", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"]);
  if (!allowed.has(value.status)) fail("INVALID_VALIDATION_ASSESSMENT", "assessment status is not allowed for the operation");
  const provenance = transported.provenance;
  if (provenance.state === "INVALID" && value.status !== "BLOCKED") {
    fail("INVALID_VALIDATION_ASSESSMENT", "invalid harness evidence can only support BLOCKED");
  }
  if (!Array.isArray(value.gates) || value.gates.some((gate) => gate === null || typeof gate !== "object" || Array.isArray(gate))) {
    fail("INVALID_VALIDATION_ASSESSMENT", "assessment gates must be an array of structured Gate assessments");
  }
  const gateAuthority = {
    fingerprint: provenance.inputs.requirementsAuthority.slice("sha256:".length),
    revision: provenance.inputs.planRevision,
    slice: result.slice,
  };
  try {
    for (const gate of value.gates) evaluateQualityGate(gate, gateAuthority);
  } catch (error) {
    fail("INVALID_VALIDATION_ASSESSMENT", `assessment Gate assessments are invalid: ${error.message}`);
  }
  const manifest = uniqueTextArray(value.manifest, "assessment manifest").sort((left, right) => left.localeCompare(right, "en"));
  const evidencePaths = provenance.subjects.map((subject) => subject.path).sort((left, right) => left.localeCompare(right, "en"));
  if (formal && new Set(["PASS", "ACCEPTED"]).has(value.status)
    && (manifest.length !== evidencePaths.length || manifest.some((entry, index) => entry !== evidencePaths[index]))) {
    fail("INVALID_VALIDATION_ASSESSMENT", "successful formal assessment manifest must match sealed evidence subjects exactly");
  }
  if ((manifest.length === 0) !== (value.filelessReason !== null)) {
    fail("INVALID_VALIDATION_ASSESSMENT", "assessment filelessReason must exist exactly for an empty manifest");
  }
  return Object.freeze({
    ...value,
    evidence: assessmentText(value.evidence, "assessment evidence"),
    verifiedScope: assessmentText(value.verifiedScope, "assessment verifiedScope"),
    findingReferences: assessmentText(value.findingReferences, "assessment findingReferences", { allowNone: true }),
    findingDispositions: assessmentText(value.findingDispositions, "assessment findingDispositions", { allowNone: true }),
    blockers: assessmentText(value.blockers, "assessment blockers", { allowNone: true }),
    overlaps: assessmentText(value.overlaps, "assessment overlaps", { allowNone: true }),
    regressions: assessmentText(value.regressions, "assessment regressions", { allowNone: true }),
    persistenceSummary: assessmentText(value.persistenceSummary, "assessment persistenceSummary"),
    manifest: Object.freeze(manifest), gates: Object.freeze(value.gates.map((gate) => Object.freeze({ ...gate }))),
  });
}

function formalPersistence(result, assessment, provenance) {
  const number = result.context.attemptCount + 1;
  const identifier = `attempt-${String(number).padStart(2, "0")}`;
  const type = number === 1 ? "initial" : "revalidation";
  const commands = commandLines(provenance);
  const gateLine = assessment.gates.length === 0 ? [] : [`- Gate assessments: ${JSON.stringify(assessment.gates)}`];
  const attempt = [
    `### ${identifier}`, "", `- Type: ${type}`, `- Status: ${assessment.status}`,
    `- HEAD: ${provenance.inputs.head}`, `- Verified scope: ${assessment.verifiedScope}`,
    commands, `- Evidence provenance: ${result.sealedEvidence}`, `- Evidence: ${assessment.evidence}`,
    `- Finding references: ${assessment.findingReferences}`, `- Finding dispositions: ${assessment.findingDispositions}`,
    `- Blockers: ${assessment.blockers}`, `- Unexpected workspace effects: ${provenance.workspace.sideEffects.join(", ") || "none"}`,
    ...gateLine, `- Persistence summary: ${assessment.persistenceSummary}`,
  ].join("\n");
  let base = null;
  if (new Set(["PASS", "ACCEPTED"]).has(assessment.status)) {
    const files = provenance.subjects.length === 0
      ? `- Files: none\n- Fileless reason: ${assessment.filelessReason}`
      : `- Files:\n${provenance.subjects.map((subject) => `  - \`${subject.path}\` | ${subject.expected}`).join("\n")}`;
    base = [
      `- Origin attempt: ${identifier}`, `- Attempt type: ${type}`, `- HEAD: ${provenance.inputs.head}`,
      `- Result: ${assessment.status}`, files,
      `- Authoritative commands:${provenance.commands.length === 0 ? " none" : `\n${provenance.commands.map((command) => `  - \`${command.display}\` | exit:${command.exit}`).join("\n")}`}`,
      `- Evidence summary: ${assessment.evidence}`,
    ].join("\n");
  }
  return Object.freeze({
    recordId: identifier, section: "Validation Attempts", markdown: attempt,
    base: base === null ? null : Object.freeze({ section: "Effective Validation Base", markdown: base }),
  });
}

export function materializeValidationAssessment(bridgeResult, assessmentOutput) {
  const { result, transported } = validateSealedBridgeResult(bridgeResult);
  const assessment = validateValidationAssessment(result, assessmentOutput);
  const persistence = result.operation === "VALIDATE_SLICE"
    ? formalPersistence(result, assessment, transported.provenance)
    : auxiliaryRecord(
      result.context.plan, transported.provenance, result.sealedEvidence,
      assessment.status, result.context.task, assessment.gates,
    );
  const resolution = result.context.task.delegationBlocker?.state === "active"
    ? Object.freeze({
      section: "Delegation Blocker",
      resolvingRecord: persistence.recordId,
      text: `resolved by ${persistence.recordId} from the installed validation bridge`,
    })
    : null;
  return sealBridgeResult({ ...bridgeReceiptMaterial(result), persistence, resolution, assessment: assessmentOutput });
}

export async function executeValidationPlan(specPath, plannerOutput, dependencies = {}) {
  const resolved = dependencies.resolved ?? await resolveOwnValidationRuntime();
  const plan = await validateValidationPlan(specPath, plannerOutput, {
    resolved, environmentSelection: dependencies.environmentSelection,
  });
  const request = {
    protocol: plan.protocol,
    operation: plan.operation,
    slice: plan.slice,
    round: plan.round,
    cwd: plan.cwd,
    subjects: plan.subjects,
    commands: plan.commands.map(({ environmentScope: _environmentScope, ...command }) => command),
    baselineFingerprint: plan.baselineFingerprint,
    priorEvidenceId: plan.priorEvidenceId,
    failureConclusion: plan.failureConclusion,
    replayOriginEvidenceId: plan.replayOriginEvidenceId,
  };
  const invoked = dependencies.invoke ?? ((arguments_) => invokeValidationRuntime(resolved, arguments_));
  const execution = await invoked([specPath, JSON.stringify(request)]);
  if (execution.transport === null) {
    fail("MALFORMED_HARNESS_OUTPUT", "packaged harness produced no valid formal provenance; no provenance was fabricated");
  }
  const transported = transportedValidationResult(execution.transport);
  const provenance = transported.provenance;
  const status = bridgeStatus(plan, provenance);
  let persistence = null;
  if (status !== "ASSESSMENT_REQUIRED") {
    persistence = provenance.classification === "INFRASTRUCTURE_BLOCKED" && provenance.workspace.kind === "pre-check"
      ? infrastructureDelegationBlocker(plan, provenance, execution.transport, plan.task)
      : auxiliaryRecord(plan, provenance, execution.transport, status, plan.task);
  }
  const activeBlocker = plan.task.delegationBlocker?.state === "active" ? plan.task.delegationBlocker : null;
  return sealBridgeResult({
    schema: VALIDATION_BRIDGE_RESULT_SCHEMA,
    planIdentity: digest("stnl-validation-plan-v1", {
      plannerOutput, environmentSelection: plan.environmentSelection.fingerprint,
    }),
    operation: plan.operation,
    slice: plan.slice,
    round: plan.round,
    summary: compactBridgeSummary(status, provenance, transported.outputs, plan),
    persistence,
    resolution: activeBlocker === null || persistence === null || persistence.section === "Delegation Blocker" ? null : Object.freeze({
      section: "Delegation Blocker",
      resolvingRecord: persistence.recordId,
      text: `resolved by ${persistence.recordId} from the installed validation bridge`,
    }),
    sealedEvidence: execution.transport,
    context: Object.freeze({
      attemptCount: plan.task.attempts.length,
      plan: Object.freeze({
        operation: plan.operation, round: plan.round, discovery: plan.discovery, coverage: plan.coverage,
        findings: plan.findings, priorRound: plan.priorRound,
        environmentSelectionFingerprint: plan.environmentSelection.fingerprint,
      }),
      task: Object.freeze({
        implementationChecks: Object.freeze(plan.task.implementationChecks.map(({ id }) => Object.freeze({ id }))),
        findingsChecks: Object.freeze(plan.task.findingsChecks.map(({ id }) => Object.freeze({ id }))),
        attempts: Object.freeze(plan.task.attempts.map(({ id }) => Object.freeze({ id }))),
        delegationBlocker: plan.task.delegationBlocker === null ? null : Object.freeze({
          operation: plan.task.delegationBlocker.operation,
          state: plan.task.delegationBlocker.state,
        }),
      }),
    }),
    assessment: null,
  });
}

export async function invokeOwnValidationRuntime(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 2
    || arguments_.some((argument) => typeof argument !== "string")) {
    fail("INVALID_VALIDATION_INVOCATION", "validation runtime invocation requires SPEC_PATH and REQUEST_JSON only");
  }
  const resolved = await resolveOwnValidationRuntime();
  const execution = await invokeValidationRuntime(resolved, arguments_);
  if (execution.transport === null) {
    if (execution.errors !== "") process.stderr.write(execution.errors);
    process.stderr.write("BLOCKED: MALFORMED_HARNESS_OUTPUT: packaged harness produced no valid formal provenance\n");
    return 1;
  }
  process.stdout.write(`${execution.transport}\n`);
  return execution.exit;
}

async function writeBridgeReceipt(result) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-validation-bridge-"));
  const file = path.join(directory, "result.json");
  await fs.writeFile(file, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

async function readBridgeReceipt(file) {
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 2_500_000) {
    fail("INVALID_VALIDATION_BRIDGE_RECEIPT", "bridge receipt must be a bounded real file");
  }
  let result;
  try { result = JSON.parse(await fs.readFile(file, "utf8")); } catch {
    fail("INVALID_VALIDATION_BRIDGE_RECEIPT", "bridge receipt is not valid JSON");
  }
  validateSealedBridgeResult(result);
  return result;
}

function replaceSection(source, heading, transform) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(## ${escaped}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`, "u");
  const match = pattern.exec(source);
  if (match === null) fail("INVALID_VALIDATION_CANDIDATE", `candidate task is missing ${heading}`);
  return source.replace(pattern, `${match[1]}${transform(match[2].trim())}`);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openControlledCandidateTask(taskFile) {
  const before = await fs.lstat(taskFile, { bigint: true }).catch(() => null);
  if (before === null || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    fail("INVALID_VALIDATION_CANDIDATE", "candidate slice task must be a single-link real file");
  }
  const handle = await fs.open(taskFile, FS_CONSTANTS.O_RDWR | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      fail("INVALID_VALIDATION_CANDIDATE", "candidate slice task identity changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function replaceControlledFile(handle, content) {
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    fail("INVALID_VALIDATION_CANDIDATE", "candidate slice task lost its single-link identity before staging");
  }
  const bytes = Buffer.from(content, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) fail("INVALID_VALIDATION_CANDIDATE", "candidate slice task write made no progress");
    offset += bytesWritten;
  }
  await handle.sync();
}

export async function stageValidationBridgeResult(specPath, bridgeResult, candidateExecutionRoot) {
  const { result } = validateSealedBridgeResult(bridgeResult);
  if (result.persistence === null) {
    fail("VALIDATION_ASSESSMENT_REQUIRED", "bridge result requires independent assessment before candidate materialization");
  }
  await preflightExecutionOperation(specPath, result.operation, String(Number.parseInt(result.slice.slice("slice-".length), 10)));
  let destination;
  try {
    destination = await validateExecutionCandidateDestination(specPath, candidateExecutionRoot);
  } catch (error) {
    fail("INVALID_VALIDATION_CANDIDATE", error.message);
  }
  const root = destination.candidateExecutionRoot;
  const taskFile = path.join(root, "tasks", `${result.slice}.md`);
  const handle = await openControlledCandidateTask(taskFile);
  try {
    let task = await handle.readFile({ encoding: "utf8" });
    const append = (current, markdown) => new Set(["- none", "- pending"]).has(current)
      ? markdown : `${current}\n\n${markdown}`;
    if (result.persistence.section === "Delegation Blocker") {
      task = replaceSection(task, result.persistence.section, (current) => {
        if (result.persistence.unchanged === true) return current;
        if (result.persistence.observation !== undefined) {
          const latestMarker = current.lastIndexOf("\n### delegation-blocker-");
          const activeEpisode = current.slice(latestMarker < 0 ? 0 : latestMarker);
          if (activeEpisode.split("\n").includes(`  - ${result.persistence.observation}`)) return current;
          return activeEpisode.includes("\n- Observations:\n")
            ? `${current}\n  - ${result.persistence.observation}`
            : `${current}\n- Observations:\n  - ${result.persistence.observation}`;
        }
        if (current === "- none") {
          if (result.persistence.episodeId !== "delegation-blocker-01") {
            fail("INVALID_VALIDATION_CANDIDATE", "first Delegation Blocker episode identity is inconsistent");
          }
          return result.persistence.markdown;
        }
        const next = `delegation-blocker-${String((current.match(/^### delegation-blocker-[0-9]{2,}$/gmu) ?? []).length + 2).padStart(2, "0")}`;
        if (result.persistence.episodeId !== next) {
          fail("INVALID_VALIDATION_CANDIDATE", "next Delegation Blocker episode identity is inconsistent");
        }
        return `${current}\n\n### ${next}\n\n${result.persistence.markdown}`;
      });
    } else {
      task = replaceSection(task, result.persistence.section, (current) => append(current, result.persistence.markdown));
    }
    if (result.persistence.base !== null && result.persistence.base !== undefined) {
      task = replaceSection(task, result.persistence.base.section, () => result.persistence.base.markdown);
    }
    if (result.resolution !== null) {
      task = replaceSection(task, result.resolution.section, (current) => {
        const activeStates = current.match(/^- State: active$/gmu) ?? [];
        if (activeStates.length !== 1) {
          fail("INVALID_VALIDATION_CANDIDATE", "authorized Delegation Blocker is not uniquely active");
        }
        return `${current.replace(/^- State: active$/mu, "- State: resolved")}\n- Resolution: ${result.resolution.text}`;
      });
    }
    await replaceControlledFile(handle, task);
  } finally {
    await handle.close();
  }
  return validateExecutionCandidate(specPath, root);
}

async function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  const invoked = await fs.realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1]));
  const loaded = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
  return invoked === loaded;
}

export async function main(arguments_) {
  try {
    if (arguments_.length === 1 && arguments_[0] === "--resolve") {
      process.stdout.write(`${(await resolveOwnValidationRuntime()).runtimePath}\n`);
      return 0;
    }
    if (arguments_.length === 1 && arguments_[0] === "--capabilities") {
      const resolved = await resolveOwnValidationRuntime();
      process.stdout.write(`${JSON.stringify({
        runner: resolved.runnerProtocol, harness: resolved.harnessProtocol,
        capability: resolved.capabilityIdentity,
        packageIdentity: resolved.packageIdentity,
        packageCoherent: resolved.packageCoherent,
      })}\n`);
      return resolved.packageCoherent ? 0 : 1;
    }
    if (arguments_.length === 3 && arguments_[0] === "--discover-environments") {
      let request;
      try { request = JSON.parse(arguments_[2]); } catch {
        fail("INVALID_ENVIRONMENT_DISCOVERY_SCOPE", "environment discovery request is not valid JSON");
      }
      process.stdout.write(`${JSON.stringify(await discoverValidationEnvironments(arguments_[1], request))}\n`);
      return 0;
    }
    if (arguments_.length === 3 && arguments_[0] === "--resolve-environment-selection") {
      let discovery;
      let choices;
      try {
        discovery = JSON.parse(arguments_[1]);
        choices = JSON.parse(arguments_[2]);
      } catch {
        fail("INVALID_ENVIRONMENT_DISCOVERY", "environment discovery or choices are not valid JSON");
      }
      process.stdout.write(`${JSON.stringify(resolveValidationEnvironmentSelection(discovery, choices))}\n`);
      return 0;
    }
    if (arguments_.length === 4 && arguments_[0] === "--execute-plan") {
      let plan;
      try { plan = JSON.parse(arguments_[2]); } catch {
        fail("INVALID_VALIDATION_PLAN", "planner output is not valid JSON");
      }
      let environmentSelection;
      try { environmentSelection = JSON.parse(arguments_[3]); } catch {
        fail("VALIDATION_ENVIRONMENT_SELECTION_REQUIRED", "independent environment selection is not valid JSON");
      }
      const result = await executeValidationPlan(arguments_[1], plan, { environmentSelection });
      const resultFile = await writeBridgeReceipt(result);
      process.stdout.write(`${JSON.stringify({
        schema: result.schema, planIdentity: result.planIdentity, operation: result.operation,
        slice: result.slice, round: result.round, summary: result.summary,
        assessmentRequired: result.persistence === null, resultFile,
      })}\n`);
      return result.summary.state === "INVALID" ? 1 : 0;
    }
    if (arguments_.length === 3 && arguments_[0] === "--assess-result") {
      let assessment;
      try { assessment = JSON.parse(arguments_[2]); } catch {
        fail("INVALID_VALIDATION_ASSESSMENT", "assessment output is not valid JSON");
      }
      const result = materializeValidationAssessment(await readBridgeReceipt(arguments_[1]), assessment);
      const resultFile = await writeBridgeReceipt(result);
      process.stdout.write(`${JSON.stringify({
        schema: result.schema, planIdentity: result.planIdentity, operation: result.operation,
        slice: result.slice, round: result.round, summary: { ...result.summary, status: assessment.status },
        assessmentRequired: false, resultFile,
      })}\n`);
      return 0;
    }
    if (arguments_.length === 4 && arguments_[0] === "--stage-candidate") {
      const staged = await stageValidationBridgeResult(arguments_[1], await readBridgeReceipt(arguments_[2]), arguments_[3]);
      process.stdout.write(`${JSON.stringify({ status: "CANDIDATE_ACCEPTED", state: staged.state })}\n`);
      return 0;
    }
    return await invokeOwnValidationRuntime(arguments_);
  } catch (error) {
    if (error instanceof ValidationRuntimeResolutionError || error instanceof ValidationEnvironmentSelectionError) {
      process.stderr.write(`BLOCKED: ${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (await isDirectInvocation()) process.exitCode = await main(process.argv.slice(2));
