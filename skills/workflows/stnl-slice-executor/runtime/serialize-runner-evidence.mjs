#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectExecutionState, resolveExecutionWorkspace } from "./execution-state.mjs";

function fail(message) {
  throw new Error(message);
}

const CLI_HELP = `Usage:
  serialize-runner-evidence.mjs --execution-bundle --operation <EXECUTE_SLICE|APPLY_FINDINGS> --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) --semantic-response-file <absolute> [--insert-candidate]
  serialize-runner-evidence.mjs --record --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) [--target <absolute>]... [--removed <relative>]... --command "<command>" --exit <integer>...
  serialize-runner-evidence.mjs --response --operation <operation> --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) [--value "semantic value"]... [--target <absolute>]... [--removed <relative>]... [--command "<command>" --exit <integer>]...
  serialize-runner-evidence.mjs --manifest --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) [--target <absolute>]... [--removed <relative>]... --command "<command>" --exit <integer>...
  serialize-runner-evidence.mjs --validation-bundle --operation VALIDATE_SLICE --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) [--value "semantic value"]... [--target <absolute>]... [--removed <relative>]... --command "<command>" --exit <integer>...
  serialize-runner-evidence.mjs --validation-bundle --operation VALIDATE_SLICE --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) --semantic-response-file <absolute>
`;

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(`${label} must be a normalized relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value === ".") fail(`${label} must be a normalized relative path`);
  return value;
}

async function regularFile(file, label) {
  const metadata = await fs.lstat(file).catch((error) => fail(`${label} is not available: ${error.message}`));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return fs.realpath(file);
}

function canonicalSliceLabel(value) {
  if (typeof value !== "string" || !/^(?:slice-)?[0-9]+$/u.test(value)) {
    fail("slice must be an unsigned decimal or canonical slice label");
  }
  const digits = value.startsWith("slice-") ? value.slice("slice-".length) : value;
  const number = BigInt(digits);
  if (number < 1n) fail("slice must be positive");
  return `slice-${number.toString(10).padStart(2, "0")}`;
}

async function deriveTaskArtifact({ specPath, slice }) {
  if (typeof specPath !== "string" || !path.isAbsolute(specPath)) fail("specPath must be absolute");
  const { executionRoot } = await resolveExecutionWorkspace(specPath);
  const taskArtifact = path.join(executionRoot, "tasks", `${canonicalSliceLabel(slice)}.md`);
  await regularFile(taskArtifact, "derived taskArtifact");
  return taskArtifact;
}

async function canonicalWorkspacePath(workspace) {
  if (!path.isAbsolute(workspace)) fail("workspace must be absolute");
  const metadata = await fs.lstat(workspace).catch((error) => fail(`workspace is not available: ${error.message}`));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("workspace must be a regular non-symlink directory");
  return fs.realpath(workspace);
}

function claimFor(taskArtifact, physicalTarget) {
  const claim = path.relative(path.dirname(taskArtifact), physicalTarget).split(path.sep).join("/");
  return normalizedRelative(claim, "task-relative claim");
}

async function canonicalEvidenceEntries({ workspace, taskArtifact, targets = [], removed = [] }) {
  if (!Array.isArray(targets) || !Array.isArray(removed)) fail("targets and removed must be arrays");
  if (targets.length === 0 && removed.length === 0) fail("at least one semantic evidence target is required");

  const workspaceRoot = await canonicalWorkspacePath(workspace);
  if (!path.isAbsolute(taskArtifact)) fail("taskArtifact must be absolute");
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact");
  if (!inside(canonicalTask, workspaceRoot)) fail("taskArtifact must belong to workspace");

  const entries = [];
  const claims = new Set();
  const physical = new Set();
  for (const target of targets) {
    if (typeof target !== "string" || !path.isAbsolute(target)) fail("file-backed targets must be absolute");
    const canonicalTarget = await regularFile(target, "file-backed target");
    if (!inside(canonicalTarget, workspaceRoot)) fail("file-backed target must belong to workspace");
    const claim = claimFor(canonicalTask, canonicalTarget);
    if (claims.has(claim)) fail(`duplicate task-relative claim: ${claim}`);
    if (physical.has(canonicalTarget)) fail(`duplicate physical target: ${canonicalTarget}`);
    claims.add(claim);
    physical.add(canonicalTarget);
    const digest = createHash("sha256").update(await fs.readFile(canonicalTarget)).digest("hex");
    entries.push({ claim, value: `sha256:${digest}` });
  }

  for (const value of removed) {
    const claim = normalizedRelative(value, "removed task-relative claim");
    const resolved = path.resolve(path.dirname(canonicalTask), claim);
    if (!inside(resolved, workspaceRoot)) fail(`removed claim escapes workspace: ${claim}`);
    if (claims.has(claim)) fail(`duplicate task-relative claim: ${claim}`);
    claims.add(claim);
    entries.push({ claim, value: "REMOVED" });
  }
  return entries.sort((left, right) => left.claim.localeCompare(right.claim, "en"));
}

async function canonicalTestedScope({ workspace, taskArtifact, targets = [], removed = [] }) {
  const entries = await canonicalEvidenceEntries({ workspace, taskArtifact, targets, removed });
  return entries.map(({ claim }) => claim).join(", ");
}

function serializeCommands(commands) {
  if (!Array.isArray(commands)) fail("commands must be an array");
  return commands.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`command ${index + 1} must be an object`);
    }
    if (typeof entry.command !== "string" || entry.command.length === 0 || entry.command.includes("\n") || entry.command.includes("\r") || entry.command.includes("`")) {
      fail(`command ${index + 1} must be a complete single-line command without backticks`);
    }
    if (!Number.isSafeInteger(entry.exit)) fail(`command ${index + 1} exit must be an integer`);
    return `  - \`${entry.command}\` | exit:${entry.exit}`;
  }).join("\n");
}

const RESPONSE_FIELDS = Object.freeze({
  EXECUTE_SLICE: [
    "Operation", "Status", "Automatic check round", "HEAD", "Tested scope", "Discovery sources",
    "Discovery actions", "Verification types considered", "Non-applicability rationale",
    "No verification-command confirmation", "Result of each command and exit code", "Selected checks",
    "Selection rationale", "Coverage", "Failures", "Evidence or failure summary",
    "Affected files or behaviors", "Blockers", "Unexpected workspace effects", "Persistence summary",
  ],
  APPLY_FINDINGS: [
    "Operation", "Status", "Automatic check round", "Findings cycle", "HEAD", "Tested scope",
    "Discovery sources", "Discovery actions", "Verification types considered", "Non-applicability rationale",
    "No verification-command confirmation", "Result of each command and exit code", "Selected checks",
    "Selection rationale", "Coverage", "Findings verified", "Corrections covered", "Regressions selected",
    "Unsupported active findings", "Failures", "Evidence or failure summary", "Affected files or behaviors",
    "Blockers", "Unexpected workspace effects", "Persistence summary",
  ],
  VALIDATE_SLICE: [
    "Operation", "Type", "Status", "Verified scope", "HEAD", "Evidence", "Finding references",
    "Finding dispositions", "Blockers", "Unexpected workspace effects", "Persistence summary",
  ],
});

const SEMANTIC_EXECUTION_FIELDS = Object.freeze({
  EXECUTE_SLICE: [
    "Status", "Automatic check round", "HEAD", "Discovery sources", "Discovery actions",
    "Verification types considered", "Non-applicability rationale", "No verification-command confirmation",
    "Commands", "Result of each command and exit code", "Selected checks", "Selection rationale", "Coverage",
    "Failures", "Prior-round failure", "Correction applied", "In-slice rationale", "Evidence or failure summary",
    "Affected files or behaviors", "Blockers",
    "Unexpected workspace effects", "Persistence summary",
  ],
  APPLY_FINDINGS: [
    "Status", "Automatic check round", "Findings cycle", "HEAD", "Discovery sources", "Discovery actions",
    "Verification types considered", "Non-applicability rationale", "No verification-command confirmation",
    "Commands", "Result of each command and exit code", "Selected checks", "Selection rationale", "Coverage",
    "Findings verified", "Corrections covered", "Regressions selected", "Unsupported active findings", "Failures",
    "Evidence or failure summary", "Affected files or behaviors", "Blockers", "Unexpected workspace effects", "Persistence summary",
  ],
});

const MACHINE_EXECUTION_FIELDS = Object.freeze({
  EXECUTE_SLICE: Object.freeze([
    ["status", "Status"],
    ["automaticCheckRound", "Automatic check round"],
    ["head", "HEAD"],
    ["discoverySources", "Discovery sources"],
    ["discoveryActions", "Discovery actions"],
    ["verificationTypesConsidered", "Verification types considered"],
    ["nonApplicabilityRationale", "Non-applicability rationale"],
    ["noVerificationCommandConfirmation", "No verification-command confirmation"],
    ["commands", "Commands"],
    ["resultOfEachCommandAndExitCode", "Result of each command and exit code"],
    ["selectedChecks", "Selected checks"],
    ["selectionRationale", "Selection rationale"],
    ["coverage", "Coverage"],
    ["failures", "Failures"],
    ["priorRoundFailure", "Prior-round failure"],
    ["correctionApplied", "Correction applied"],
    ["inSliceRationale", "In-slice rationale"],
    ["evidenceOrFailureSummary", "Evidence or failure summary"],
    ["affectedFilesOrBehaviors", "Affected files or behaviors"],
    ["blockers", "Blockers"],
    ["unexpectedWorkspaceEffects", "Unexpected workspace effects"],
    ["persistenceSummary", "Persistence summary"],
  ]),
  APPLY_FINDINGS: Object.freeze([
    ["status", "Status"],
    ["automaticCheckRound", "Automatic check round"],
    ["findingsCycle", "Findings cycle"],
    ["head", "HEAD"],
    ["discoverySources", "Discovery sources"],
    ["discoveryActions", "Discovery actions"],
    ["verificationTypesConsidered", "Verification types considered"],
    ["nonApplicabilityRationale", "Non-applicability rationale"],
    ["noVerificationCommandConfirmation", "No verification-command confirmation"],
    ["commands", "Commands"],
    ["resultOfEachCommandAndExitCode", "Result of each command and exit code"],
    ["selectedChecks", "Selected checks"],
    ["selectionRationale", "Selection rationale"],
    ["coverage", "Coverage"],
    ["findingsVerified", "Findings verified"],
    ["correctionsCovered", "Corrections covered"],
    ["regressionsSelected", "Regressions selected"],
    ["unsupportedActiveFindings", "Unsupported active findings"],
    ["failures", "Failures"],
    ["evidenceOrFailureSummary", "Evidence or failure summary"],
    ["affectedFilesOrBehaviors", "Affected files or behaviors"],
    ["blockers", "Blockers"],
    ["unexpectedWorkspaceEffects", "Unexpected workspace effects"],
    ["persistenceSummary", "Persistence summary"],
  ]),
});

function validateScalarField(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r") || value.includes("`")) {
    fail(`${name} must be a complete single-line scalar without backticks`);
  }
  return value;
}

const EXPLANATORY_EXECUTION_FIELDS = new Set([
  "Discovery sources", "Discovery actions", "Verification types considered", "Non-applicability rationale",
  "No verification-command confirmation", "Result of each command and exit code", "Selected checks",
  "Selection rationale", "Coverage", "Failures", "Prior-round failure", "Correction applied",
  "In-slice rationale", "Evidence or failure summary", "Affected files or behaviors", "Blockers",
  "Unexpected workspace effects", "Persistence summary", "Regressions selected", "Fileless reason",
]);

const EXPLANATORY_VALIDATION_FIELDS = new Set([
  "evidence", "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
]);

function serializeMarkdownScalar(name, value, explanatory = false) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r")) {
    fail(`${name} must be a complete single-line scalar`);
  }
  if (!explanatory) return validateScalarField(name, value);
  return value.includes("`") || value.startsWith("json:") ? `json:${JSON.stringify(value)}` : value;
}

function decodeMarkdownScalar(name, value, explanatory = false) {
  if (!explanatory) return validateScalarField(name, value);
  if (!value.startsWith("json:")) {
    serializeMarkdownScalar(name, value, true);
    return value;
  }
  const encoded = value.slice("json:".length);
  let decoded;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    fail(`${name} must use a canonical json-quoted scalar`);
  }
  if (typeof decoded !== "string" || decoded.length === 0 || decoded.includes("\n") || decoded.includes("\r")
    || `json:${JSON.stringify(decoded)}` !== value) {
    fail(`${name} must use a canonical json-quoted scalar`);
  }
  return decoded;
}

function canonicalSemanticValidationScalar(name, value) {
  if (EXPLANATORY_VALIDATION_FIELDS.has(name)) {
    serializeMarkdownScalar(name, value, true);
    return value;
  }
  return validateScalarField(name, value);
}

function responseFieldNames(operation, fields) {
  const base = RESPONSE_FIELDS[operation];
  if (base === undefined) return undefined;
  if (operation !== "EXECUTE_SLICE" || fields?.["Automatic check round"] === "1/3") return base;
  return [
    ...base,
    "Prior-round failure",
    "Correction applied",
    "Correction paths",
    "Updated scope",
    "In-slice rationale",
  ];
}

function serializeResponseFields(operation, fields) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) fail("response fields must be an object");
  const expected = responseFieldNames(operation, fields);
  if (expected === undefined) fail(`unsupported response operation: ${operation}`);
  const allowed = new Set(expected);
  const provided = Object.keys(fields);
  const unknown = provided.filter((name) => !allowed.has(name));
  if (unknown.length !== 0) fail(`unknown response field: ${unknown[0]}`);
  for (const name of expected) {
    if (!Object.hasOwn(fields, name)) fail(`missing response field: ${name}`);
    serializeMarkdownScalar(name, fields[name], EXPLANATORY_EXECUTION_FIELDS.has(name));
  }
  if (fields.Operation !== operation) fail(`response Operation must be ${operation}`);
  return expected.map((name) => `${name}: ${serializeMarkdownScalar(name, fields[name], EXPLANATORY_EXECUTION_FIELDS.has(name))}`);
}

function responseFieldsFromValues(operation, values) {
  if (!Array.isArray(values)) fail("response semantic values must be an array");
  const expected = RESPONSE_FIELDS[operation];
  if (expected === undefined) fail(`unsupported response operation: ${operation}`);
  if (values.length !== expected.length - 1) {
    fail(`response semantic values must contain exactly ${expected.length - 1} values for ${operation}`);
  }
  return Object.fromEntries([
    [expected[0], operation],
    ...expected.slice(1).map((name, index) => [name, values[index]]),
  ]);
}

export async function serializeRunnerEvidence({ workspace, taskArtifact, targets = [], removed = [], commands = [] }) {
  const entries = await canonicalEvidenceEntries({ workspace, taskArtifact, targets, removed });
  return entries.map(({ claim, value }) => `  - \`${claim}\` | ${value}`).join("\n");
}

export async function serializeRunnerRecord({ workspace, taskArtifact, targets = [], removed = [], commands = [], filelessReason = null, allowEmptyCommands = false }) {
  const hasFileBackedState = targets.length !== 0 || removed.length !== 0;
  let testedState;
  if (hasFileBackedState) {
    if (filelessReason !== null) fail("filelessReason is only valid for a fileless state");
    testedState = await serializeRunnerEvidence({ workspace, taskArtifact, targets, removed, commands });
  } else {
    testedState = `- Tested state: none\n- Fileless reason: ${serializeMarkdownScalar("filelessReason", filelessReason ?? "", true)}`;
  }
  const serializedCommands = serializeCommands(commands);
  if (serializedCommands.length === 0 && !allowEmptyCommands) fail("at least one executed command is required");
  const commandBlock = serializedCommands.length === 0 ? "- Commands: none" : `- Commands:\n${serializedCommands}`;
  return `- Tested state:\n${testedState}\n${commandBlock}`;
}

export async function serializeRunnerManifest({ workspace, taskArtifact, targets = [], removed = [], commands = [], filelessReason = null }) {
  const hasFileBackedState = targets.length !== 0 || removed.length !== 0;
  let files;
  if (hasFileBackedState) {
    if (filelessReason !== null) fail("filelessReason is only valid for a fileless manifest");
    files = `- Files:\n${await serializeRunnerEvidence({ workspace, taskArtifact, targets, removed })}`;
  } else {
    files = `- Files: none\n- Fileless reason: ${serializeMarkdownScalar("filelessReason", filelessReason ?? "", true)}`;
  }
  const serializedCommands = serializeCommands(commands);
  if (serializedCommands.length === 0) fail("at least one authoritative command is required");
  return `${files}\n- Authoritative commands:\n${serializedCommands}`;
}

export async function serializeRunnerResponse({ operation, fields, values, workspace, taskArtifact, targets = [], removed = [], commands = [], filelessReason = null }) {
  if (fields !== undefined && values !== undefined) fail("response fields and semantic values are mutually exclusive");
  const responseFields = values === undefined ? { ...fields } : responseFieldsFromValues(operation, values);
  if (operation !== "VALIDATE_SLICE" && (targets.length !== 0 || removed.length !== 0)) {
    responseFields["Tested scope"] = await canonicalTestedScope({ workspace, taskArtifact, targets, removed });
  }
  const scalarLines = serializeResponseFields(operation, responseFields);

  if (operation === "VALIDATE_SLICE") {
    const serializedCommands = serializeCommands(commands);
    if (serializedCommands.length === 0) {
      if (responseFields.Status !== "BLOCKED") fail("a non-blocked validation response requires executed commands");
      scalarLines.splice(5, 0, "Commands: none");
    } else {
      scalarLines.splice(5, 0, `Commands:\n${serializedCommands}`);
    }
    return scalarLines.join("\n");
  }

  const insertion = scalarLines.findIndex((line) => line.startsWith("Tested scope: "));
  if (insertion < 0) fail("response field insertion point is unavailable");
  const hasFileBackedState = targets.length !== 0 || removed.length !== 0;
  let testedLines;
  if (hasFileBackedState) {
    if (filelessReason !== null) fail("filelessReason is only valid for a fileless state");
    testedLines = `Tested state:\n${await serializeRunnerEvidence({ workspace, taskArtifact, targets, removed })}`;
  } else {
    testedLines = `Tested state: none\nFileless reason: ${serializeMarkdownScalar("filelessReason", filelessReason ?? "", true)}`;
  }
  const serializedCommands = serializeCommands(commands);
  if (responseFields.Status !== "BLOCKED" && responseFields.Status !== "TESTS_NOT_APPLICABLE" && serializedCommands.length === 0) {
    fail("a non-blocked response requires executed commands");
  }
  const commandLines = serializedCommands.length === 0 ? "Commands: none" : `Commands:\n${serializedCommands}`;
  scalarLines.splice(insertion + 1, 0, testedLines);
  const commandIndex = scalarLines.findIndex((line) => line.startsWith("No verification-command confirmation: "));
  if (commandIndex < 0) fail("response Commands insertion point is unavailable");
  scalarLines.splice(commandIndex + 1, 0, commandLines);
  return scalarLines.join("\n");
}

export async function serializeRunnerValidationBundle({ operation = "VALIDATE_SLICE", values, workspace, taskArtifact, targets = [], removed = [], commands = [], filelessReason = null }) {
  if (operation !== "VALIDATE_SLICE") fail("validation bundle operation must be VALIDATE_SLICE");
  const response = await serializeRunnerResponse({ operation, values, workspace, taskArtifact, targets, removed, commands, filelessReason });
  const record = await serializeRunnerRecord({ workspace, taskArtifact, targets, removed, commands, filelessReason });
  const manifest = await serializeRunnerManifest({ workspace, taskArtifact, targets, removed, commands, filelessReason });
  return `- Runner response:\n${response}\n- Tested record:\n${record}\n- Formal manifest:\n${manifest}`;
}

function parseSemanticExecutionResponse(text, operation) {
  const expected = SEMANTIC_EXECUTION_FIELDS[operation];
  if (expected === undefined) fail(`unsupported semantic execution operation: ${operation}`);
  if (typeof text !== "string" || text.length === 0) fail("semantic execution response must be non-empty text");
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const values = {};
  let cursor = 0;
  for (const field of expected) {
    if (field === "Commands") {
      if (lines[cursor] === "Commands: none") {
        values.Commands = [];
        cursor += 1;
        continue;
      }
      if (lines[cursor] !== "Commands:") fail("semantic execution response must contain the exact Commands field");
      cursor += 1;
      const commands = [];
      while (cursor < lines.length && lines[cursor].startsWith("  - ")) {
        const match = lines[cursor].match(/^  - `([^`\n]+)` \| exit:(-?[0-9]+)$/u);
        if (match === null) fail("semantic execution response contains a malformed command tuple");
        commands.push({ command: match[1], exit: Number(match[2]) });
        cursor += 1;
      }
      if (commands.length === 0) fail("semantic execution response must contain at least one command tuple or Commands: none");
      values.Commands = commands;
      continue;
    }
    const prefix = `${field}: `;
    if (!lines[cursor]?.startsWith(prefix)) fail(`semantic execution response must contain ${field} in canonical order`);
    const value = lines[cursor].slice(prefix.length);
    values[field] = decodeMarkdownScalar(field, value, EXPLANATORY_EXECUTION_FIELDS.has(field));
    cursor += 1;
    if (field === "HEAD" && lines[cursor]?.startsWith("Fileless reason: ")) {
      values.filelessReason = decodeMarkdownScalar("Fileless reason", lines[cursor].slice("Fileless reason: ".length), true);
      cursor += 1;
    }
  }
  if (cursor !== lines.length) fail("semantic execution response contains preamble, postamble, or unknown fields");
  if (values.Commands.length === 0 && !new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(values.Status)) {
    fail("non-blocked semantic execution response requires executed commands");
  }
  return values;
}

function parseSemanticExecutionPayload(text, operation) {
  const fields = MACHINE_EXECUTION_FIELDS[operation];
  if (fields === undefined) fail(`unsupported semantic execution operation: ${operation}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("semantic execution payload must be one canonical JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail("semantic execution payload must be one canonical JSON object");
  }
  const allowed = new Set([...fields.map(([key]) => key), "filelessReason"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) fail(`unknown semantic execution payload field: ${key}`);
  }
  for (const [key] of fields) {
    if (!Object.hasOwn(payload, key)) fail(`missing semantic execution payload field: ${key}`);
    if (key === "commands") continue;
    serializeMarkdownScalar(key, payload[key], EXPLANATORY_EXECUTION_FIELDS.has(MACHINE_EXECUTION_FIELDS[operation].find(([candidate]) => candidate === key)?.[1]));
  }
  if (!Array.isArray(payload.commands)) fail("semantic execution payload commands must be an array");
  for (const [index, command] of payload.commands.entries()) {
    if (command === null || typeof command !== "object" || Array.isArray(command)
      || JSON.stringify(Object.keys(command).sort()) !== JSON.stringify(["command", "exit"])) {
      fail(`semantic execution payload command ${index + 1} must contain only command and exit`);
    }
    if (typeof command.command !== "string" || command.command.length === 0
      || command.command.includes("\n") || command.command.includes("\r") || command.command.includes("`")) {
      fail(`semantic execution payload command ${index + 1} is not a complete single-line command`);
    }
    if (!Number.isSafeInteger(command.exit)) fail(`semantic execution payload command ${index + 1} exit must be an integer`);
  }
  if (payload.commands.length === 0 && !new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(payload.status)) {
    fail("non-blocked semantic execution payload requires executed commands");
  }
  if (payload.automaticCheckRound !== "1/3") {
    for (const key of ["priorRoundFailure", "correctionApplied", "inSliceRationale"]) {
      if (/^(?:none|pending|n\/a)$/iu.test(payload[key])) {
        fail(`${key} is required for automatic check rounds after 1/3`);
      }
    }
  }
  if (Object.hasOwn(payload, "filelessReason")) serializeMarkdownScalar("filelessReason", payload.filelessReason, true);
  return payload;
}

const VALIDATION_SEMANTIC_KEYS = Object.freeze([
  "status", "head", "commands", "evidence", "findingReferences", "findingDispositions",
  "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
]);

function parseSemanticValidationPayload(text) {
  if (typeof text !== "string" || text.length === 0) fail("semantic validation response must be a non-empty JSON object");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("semantic validation response must be a single raw JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail("semantic validation response must be a single raw JSON object");
  }
  const keys = Object.keys(payload);
  if (JSON.stringify(keys) !== JSON.stringify(VALIDATION_SEMANTIC_KEYS)) {
    const unknown = keys.find((key) => !VALIDATION_SEMANTIC_KEYS.includes(key));
    if (unknown !== undefined) fail(`unknown semantic validation payload field: ${unknown}`);
    fail("semantic validation payload keys are missing or not in canonical order");
  }
  if (!["PASS", "NEEDS_FIX", "BLOCKED"].includes(payload.status)) {
    fail("semantic validation payload status is invalid");
  }
  for (const key of VALIDATION_SEMANTIC_KEYS) {
    if (key === "commands") continue;
    payload[key] = canonicalSemanticValidationScalar(key, payload[key]);
  }
  if (!Array.isArray(payload.commands) || payload.commands.length === 0) {
    fail("semantic validation payload commands must be a non-empty array");
  }
  for (const [index, command] of payload.commands.entries()) {
    if (command === null || typeof command !== "object" || Array.isArray(command)
      || JSON.stringify(Object.keys(command).sort()) !== JSON.stringify(["command", "exit"])) {
      fail(`semantic validation payload command ${index + 1} must contain only command and exit`);
    }
    if (typeof command.command !== "string" || command.command.length === 0
      || command.command.includes("\n") || command.command.includes("\r") || command.command.includes("`")) {
      fail(`semantic validation payload command ${index + 1} is not a complete single-line command`);
    }
    if (!Number.isSafeInteger(command.exit)) fail(`semantic validation payload command ${index + 1} exit must be an integer`);
  }
  return payload;
}

async function canonicalValidationFindingFields({ state, slice, status, findingReferences, findingDispositions }) {
  const selected = state.tasks?.get(canonicalSliceLabel(String(slice)));
  if (selected === undefined) fail("validation producer could not resolve the selected task for finding disposition serialization");
  if (selected.findings.length === 0) {
    if (status === "NEEDS_FIX" && findingReferences !== "none") {
      const references = canonicalFindingSet(findingReferences, "finding references");
      const dispositions = canonicalFindingDispositions(findingDispositions, "finding dispositions");
      if (references.length !== dispositions.length
        || references.some((identifier, index) => identifier !== dispositions[index])) {
        fail("new NEEDS_FIX finding references and dispositions disagree");
      }
      // The candidate may introduce findings whose Origin is this attempt.
      // Strict candidate validation verifies their declarations and timeline.
      return { findingReferences, findingDispositions };
    }
    if (status !== "NEEDS_FIX" && findingReferences === "none" && findingDispositions === "unchanged") {
      return { findingReferences: "none", findingDispositions: "none" };
    }
    if (findingReferences !== "none" || findingDispositions !== "none") {
      fail("validation producer received finding references although the selected task has no findings");
    }
    // An empty finding authority has one mechanical representation.  Do not
    // carry model prose such as "unchanged" into the strict record schema.
    return { findingReferences: "none", findingDispositions: "none" };
  }
  return { findingReferences, findingDispositions };
}

async function canonicalValidationPreflightCommand({ specPath, slice }) {
  if (typeof specPath !== "string" || !path.isAbsolute(specPath)
    || specPath.includes("\n") || specPath.includes("\r") || specPath.includes('"')) {
    fail("validation producer requires an absolute SPEC_PATH without command delimiters");
  }
  const sliceLabel = canonicalSliceLabel(String(slice));
  const numericSlice = BigInt(sliceLabel.slice("slice-".length)).toString(10);
  const validator = await regularFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    "official validation preflight",
  );
  return `node "${validator}" "${specPath}" VALIDATE_SLICE ${numericSlice}`;
}

function launcherOwnedPreflightCommand(command) {
  return typeof command === "string" && /\bvalidate-execution-state\.mjs\b/iu.test(command)
    && /\bVALIDATE_SLICE\b/u.test(command);
}

async function canonicalValidationCommands({ commands, specPath, slice }) {
  const launcherOwned = commands.filter(({ command }) => launcherOwnedPreflightCommand(command));
  if (launcherOwned.length !== 0) {
    fail("semantic validation commands must exclude the launcher-owned official preflight");
  }
  return [
    { command: await canonicalValidationPreflightCommand({ specPath, slice }), exit: 0 },
    ...commands,
  ];
}

function sectionBody(text, heading) {
  const marker = `## ${heading}\n`;
  const start = text.indexOf(marker);
  if (start < 0) fail(`task artifact is missing ${heading}`);
  const bodyStart = start + marker.length;
  const next = text.indexOf("\n## ", bodyStart);
  return text.slice(bodyStart, next < 0 ? text.length : next).trim();
}

function sectionRange(text, heading) {
  const marker = `## ${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0) fail(`task artifact is missing ${heading}`);
  const bodyStart = start + marker.length;
  const next = text.indexOf("\n## ", bodyStart);
  const end = next < 0 ? text.length : next;
  return { bodyStart, end, body: text.slice(bodyStart, end).trim() };
}

function replaceSectionBody(text, heading, body) {
  const section = sectionRange(text, heading);
  return `${text.slice(0, section.bodyStart)}${body}\n${text.slice(section.end)}`;
}

function checklistExpectedClaims(text) {
  const body = sectionBody(text, "Checklist");
  const claims = [];
  for (const line of body.split("\n")) {
    if (line.length === 0) continue;
    const expected = line.match(/\| expected areas: (.*?) \| requirement: /u);
    if (expected === null) fail("Checklist contains a malformed expected-areas field");
    const lineClaims = [...expected[1].matchAll(/`([^`\n]+)`/gu)].map((match) => normalizedRelative(match[1], "Checklist expected area"));
    if (lineClaims.length === 0) fail("Checklist expected areas contain no concrete path claim");
    claims.push(...lineClaims);
  }
  if (claims.length === 0) fail("Checklist contains no concrete expected area");
  return claims;
}

async function existingPhysicalCandidate(candidate, label) {
  const metadata = await fs.lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    fail(`${label} is not available: ${error.message}`);
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return fs.realpath(candidate);
}

async function canonicalApprovedTargets({ workspaceRoot, taskArtifact, taskText }) {
  const targets = new Map();
  for (const raw of checklistExpectedClaims(taskText)) {
    const candidate = path.resolve(path.dirname(taskArtifact), raw);
    const physical = await regularFile(candidate, `Checklist expected area ${raw}`);
    if (!inside(physical, workspaceRoot)) fail(`Checklist expected area escapes workspace: ${raw}`);
    targets.set(physical, raw);
  }
  return targets;
}

async function canonicalizeScopeClaim({ workspaceRoot, taskArtifact, approvedTargets, raw, heading }) {
  const claim = normalizedRelative(raw, `${heading} path`);
  const taskBasis = path.resolve(path.dirname(taskArtifact), claim);
  const workspaceBasis = path.resolve(workspaceRoot, claim);
  const taskPhysical = await existingPhysicalCandidate(taskBasis, `${heading} task-relative claim ${claim}`);
  const workspacePhysical = taskBasis === workspaceBasis
    ? taskPhysical
    : await existingPhysicalCandidate(workspaceBasis, `${heading} workspace-relative claim ${claim}`);
  if (taskPhysical !== null && workspacePhysical !== null && taskPhysical !== workspacePhysical) {
    fail(`${heading} claim is ambiguous across task and workspace bases: ${claim}`);
  }
  const physical = taskPhysical ?? workspacePhysical;
  if (physical === null) fail(`${heading} claim does not resolve to a physical target: ${claim}`);
  if (!inside(physical, workspaceRoot)) fail(`${heading} claim escapes workspace: ${claim}`);
  if (taskPhysical === null && !approvedTargets.has(physical)) {
    fail(`${heading} workspace-relative claim is not an approved physical target: ${claim}`);
  }
  return path.relative(path.dirname(taskArtifact), physical).split(path.sep).join("/");
}

async function canonicalizeScopeSection({ workspaceRoot, taskArtifact, taskText, approvedTargets, heading, allowPending = false }) {
  const body = sectionBody(taskText, heading);
  if (body === "- none") return { body, claims: [] };
  if (allowPending && body === "- pending") return { body, claims: [] };
  if (body === "- pending") fail(`${heading} cannot remain pending after execution work`);
  const rawClaims = body.split("\n").filter((line) => line.length !== 0).map((line) => {
    const match = line.match(/^- `([^`\n]+)`$/u);
    if (match === null) fail(`${heading} must contain only canonical path claims`);
    return match[1];
  });
  if (rawClaims.length === 0) fail(`${heading} must contain at least one path claim or - none`);
  const claims = [...new Set(await Promise.all(rawClaims.map((raw) => canonicalizeScopeClaim({ workspaceRoot, taskArtifact, approvedTargets, raw, heading }))))]
    .sort((left, right) => left.localeCompare(right, "en"));
  return { body: claims.map((claim) => `- \`${claim}\``).join("\n"), claims };
}

export async function serializeExecutionScopeClaims({ workspace, taskArtifact }) {
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact");
  if (!inside(canonicalTask, workspaceRoot)) fail("taskArtifact must belong to workspace");
  const before = await fs.readFile(canonicalTask, "utf8");
  const approvedTargets = await canonicalApprovedTargets({ workspaceRoot, taskArtifact: canonicalTask, taskText: before });
  const sections = [
    ["Changed Areas", false],
    ["Corrections Applied", false],
  ];
  let after = before;
  let serializedClaims = 0;
  for (const [heading, allowPending] of sections) {
    const result = await canonicalizeScopeSection({
      workspaceRoot,
      taskArtifact: canonicalTask,
      taskText: after,
      approvedTargets,
      heading,
      allowPending,
    });
    if (result.body !== sectionBody(after, heading)) after = replaceSectionBody(after, heading, result.body);
    serializedClaims += result.claims.length;
  }
  if (after !== before) {
    const temporary = `${canonicalTask}.stnl-execution-paths-${process.pid}.tmp`;
    await fs.writeFile(temporary, after, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, canonicalTask);
  }
  return Object.freeze({
    status: "PASS",
    changedPath: after === before ? null : canonicalTask,
    serializedClaims,
  });
}

function parseCanonicalPathSection(text, heading) {
  const body = sectionBody(text, heading);
  if (body === "- none") return [];
  const paths = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(/^- `([^`\n]+)`$/u);
    if (match === null) fail(`${heading} must contain only canonical path claims`);
    const claim = normalizedRelative(match[1], `${heading} path`);
    if (paths.includes(claim)) fail(`${heading} contains duplicate path claim: ${claim}`);
    paths.push(claim);
  }
  if (paths.length === 0) fail(`${heading} must contain at least one path claim or - none`);
  return paths;
}

function parseOverlapPathSection(text) {
  const body = sectionBody(text, "Prior Validation Overlap");
  if (body === "- none") return [];
  const paths = [];
  for (const line of body.split("\n")) {
    const canonicalMatch = line.match(/^- Paths: (.+)$/u);
    const semanticMatch = line.match(/^- Slice [0-9]+ overlap: (.+?); (.+)$/u);
    if (canonicalMatch === null && semanticMatch === null) continue;
    // The compact overlap sentence is a model-owned semantic carrier. The
    // producer consumes only its path carrier; physical identity and all
    // task-relative serialization remain strict below.
    const serialized = canonicalMatch?.[1] ?? semanticMatch?.[1];
    const codeSpanMatches = [...serialized.matchAll(/`([^`\n]+)`/gu)];
    if (codeSpanMatches.length === 0 && serialized.includes("`")) {
      fail("Prior Validation Overlap Paths must use balanced Markdown path claims");
    }
    const rawClaims = codeSpanMatches.length !== 0
      ? codeSpanMatches.map((entry) => entry[1])
      : serialized.split(", ");
    const canonicalSerialized = codeSpanMatches.length === 0
      ? rawClaims.join(", ")
      : rawClaims.map((raw) => `\`${raw}\``).join(", ");
    if (serialized !== canonicalSerialized) {
      fail("Prior Validation Overlap Paths must be comma-separated raw paths or balanced Markdown path claims");
    }
    for (const raw of rawClaims) {
      const claim = normalizedRelative(raw, "Prior Validation Overlap path");
      if (paths.includes(claim)) fail(`Prior Validation Overlap contains duplicate path claim: ${claim}`);
      paths.push(claim);
    }
  }
  if (paths.length === 0) fail("Prior Validation Overlap must contain canonical Paths claims or - none");
  return paths;
}

async function deriveValidationTargetsFromTask({ workspace, taskArtifact }) {
  const taskText = await fs.readFile(taskArtifact, "utf8");
  const claims = [
    ...parseCanonicalPathSection(taskText, "Changed Areas"),
    ...parseOverlapPathSection(taskText),
  ];
  const uniqueClaims = [];
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim)) continue;
    seen.add(claim);
    uniqueClaims.push(claim);
  }
  if (uniqueClaims.length === 0) fail("validation producer cannot derive a file-backed target set from the task artifact");
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const targets = [];
  for (const claim of uniqueClaims) {
    const physical = path.resolve(path.dirname(taskArtifact), claim);
    const canonical = await regularFile(physical, `task claim ${claim}`);
    if (!inside(canonical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
    targets.push(canonical);
  }
  return targets;
}

async function deriveExecutionTargetsFromTask({ workspace, taskArtifact }) {
  const taskText = await fs.readFile(taskArtifact, "utf8");
  const claims = [
    ...parseCanonicalPathSection(taskText, "Changed Areas"),
    ...parseCanonicalPathSection(taskText, "Corrections Applied"),
  ];
  const uniqueClaims = [];
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim)) continue;
    seen.add(claim);
    uniqueClaims.push(claim);
  }
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const targets = [];
  for (const claim of uniqueClaims) {
    const physical = path.resolve(path.dirname(taskArtifact), claim);
    const canonical = await regularFile(physical, `task claim ${claim}`);
    if (!inside(canonical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
    targets.push(canonical);
  }
  return targets;
}

function priorImplementationFailure(taskText, expectedRound) {
  const records = sectionBody(taskText, "Implementation Test Evidence")
    .split(/(?=^### implementation-check-[0-9]{2,}$)/mu)
    .filter((record) => record.trim() !== "");
  const record = records.at(-1);
  if (record === undefined) fail(`EXECUTE_SLICE correction requires prior implementation-check-${expectedRound}/3 evidence`);
  const round = record.match(/^- Automatic check round: ([123])\/3$/mu)?.[1];
  if (Number(round) !== expectedRound) {
    fail(`EXECUTE_SLICE correction requires prior implementation-check-${expectedRound}/3 evidence`);
  }
  if (!/^- Status: TESTS_FAIL$/mu.test(record)) {
    fail(`EXECUTE_SLICE correction requires prior round ${expectedRound}/3 TESTS_FAIL evidence`);
  }
  const testedState = new Map();
  for (const match of record.matchAll(/^  - `([^`\n]+)` \| (sha256:[0-9a-f]{64}|REMOVED)$/gmu)) {
    testedState.set(match[1], match[2]);
  }
  return testedState;
}

async function populateExecutionCorrectionClaims({ workspace, taskArtifact, operation, round }) {
  if (operation !== "EXECUTE_SLICE" || round === 1) return;
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact");
  const before = await fs.readFile(canonicalTask, "utf8");
  const priorState = priorImplementationFailure(before, round - 1);
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const approvedTargets = await canonicalApprovedTargets({ workspaceRoot, taskArtifact: canonicalTask, taskText: before });
  const changed = await canonicalizeScopeSection({
    workspaceRoot,
    taskArtifact: canonicalTask,
    taskText: before,
    approvedTargets,
    heading: "Changed Areas",
  });
  const corrections = [];
  for (const claim of changed.claims) {
    const physical = await regularFile(path.resolve(path.dirname(canonicalTask), claim), `Changed Areas target ${claim}`);
    const digest = `sha256:${createHash("sha256").update(await fs.readFile(physical)).digest("hex")}`;
    if (priorState.get(claim) !== digest) corrections.push(claim);
  }
  const existing = sectionBody(before, "Corrections Applied");
  if (existing !== "- none") {
    const declared = await canonicalizeScopeSection({
      workspaceRoot,
      taskArtifact: canonicalTask,
      taskText: before,
      approvedTargets,
      heading: "Corrections Applied",
    });
    if (JSON.stringify(declared.claims) !== JSON.stringify(corrections)) {
      fail("Corrections Applied does not match mechanically derived correction paths");
    }
    return;
  }
  const correctionBody = corrections.length === 0 ? "- none" : corrections.map((claim) => `- \`${claim}\``).join("\n");
  const after = replaceSectionBody(before, "Corrections Applied", correctionBody);
  if (after !== before) {
    const temporary = `${canonicalTask}.stnl-correction-paths-${process.pid}.tmp`;
    const mode = (await fs.stat(canonicalTask)).mode & 0o777;
    try {
      await fs.writeFile(temporary, after, { encoding: "utf8", flag: "wx", mode });
      await fs.rename(temporary, canonicalTask);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

function nextExecutionCheckId(taskText, prefix) {
  const identifiers = [...taskText.matchAll(new RegExp(`^### ${prefix}-([0-9]{2,})$`, "gmu"))]
    .map((match) => Number(match[1]));
  const next = (identifiers.length === 0 ? 0 : Math.max(...identifiers)) + 1;
  return `${prefix}-${String(next).padStart(2, "0")}`;
}

function canonicalFindingSet(value, label) {
  if (value === "none") return [];
  if (typeof value !== "string" || !/^finding-[0-9]{2,}(?:, finding-[0-9]{2,})*$/u.test(value)) {
    fail(`${label} must be none or a canonical finding set`);
  }
  const identifiers = value.split(", ");
  if (new Set(identifiers).size !== identifiers.length
    || identifiers.some((identifier, index) => index > 0 && identifier.localeCompare(identifiers[index - 1], "en") <= 0)) {
    fail(`${label} must be a unique lexicographically ordered finding set`);
  }
  return identifiers;
}

function canonicalFindingDispositions(value, label) {
  if (value === "none") return [];
  if (typeof value !== "string" || !/^finding-[0-9]{2,}=(?:active|resolved|superseded)(?:, finding-[0-9]{2,}=(?:active|resolved|superseded))*$/u.test(value)) {
    fail(`${label} must be none or canonical finding dispositions`);
  }
  const identifiers = value.split(", ").map((entry) => entry.slice(0, entry.indexOf("=")));
  if (new Set(identifiers).size !== identifiers.length
    || identifiers.some((identifier, index) => index > 0 && identifier.localeCompare(identifiers[index - 1], "en") <= 0)) {
    fail(`${label} must be unique and lexicographically ordered`);
  }
  return identifiers;
}

async function serializeCanonicalExecutionCheck({
  operation, parsed, workspace, taskArtifact, taskText, targets, testedScope,
}) {
  const scalar = (label, value) => serializeMarkdownScalar(label, value, EXPLANATORY_EXECUTION_FIELDS.has(label));
  const prefix = operation === "EXECUTE_SLICE" ? "implementation-check" : "findings-check";
  const checkId = nextExecutionCheckId(taskText, prefix);
  const testedRecord = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets,
    commands: parsed.Commands,
    filelessReason: parsed.filelessReason ?? null,
    allowEmptyCommands: new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(parsed.Status),
  });
  const lines = [
    `### ${checkId}`,
    `- Automatic check round: ${parsed["Automatic check round"]}`,
    `- Status: ${parsed.Status}`,
    `- HEAD: ${parsed.HEAD}`,
    `- Tested scope: ${testedScope}`,
    testedRecord,
    `- Discovery sources: ${scalar("Discovery sources", parsed["Discovery sources"])}`,
    `- Discovery actions: ${scalar("Discovery actions", parsed["Discovery actions"])}`,
    `- Verification types considered: ${scalar("Verification types considered", parsed["Verification types considered"])}`,
    `- Non-applicability rationale: ${scalar("Non-applicability rationale", parsed["Non-applicability rationale"])}`,
    `- No verification-command confirmation: ${scalar("No verification-command confirmation", parsed["No verification-command confirmation"])}`,
    `- Selected checks: ${scalar("Selected checks", parsed["Selected checks"])}`,
    `- Selection rationale: ${scalar("Selection rationale", parsed["Selection rationale"])}`,
    `- Coverage: ${scalar("Coverage", parsed.Coverage)}`,
    `- Failures: ${scalar("Failures", parsed.Failures)}`,
    `- Blockers: ${scalar("Blockers", parsed.Blockers)}`,
    `- Unexpected workspace effects: ${scalar("Unexpected workspace effects", parsed["Unexpected workspace effects"])}`,
    `- Persistence summary: ${scalar("Persistence summary", parsed["Persistence summary"])}`,
  ];
  if (parsed["Automatic check round"] !== "1/3") {
    lines.push(
      `- Prior-round failure: ${scalar("Prior-round failure", parsed["Prior-round failure"])}`,
      `- Correction applied: ${scalar("Correction applied", parsed["Correction applied"])}`,
      `- Correction paths: ${parsed.correctionPaths}`,
      `- Updated scope: ${testedScope}`,
      `- In-slice rationale: ${scalar("In-slice rationale", parsed["In-slice rationale"])}`,
    );
  }
  if (operation === "APPLY_FINDINGS") {
    const verified = canonicalFindingSet(parsed["Findings verified"], "Findings verified");
    const unsupported = canonicalFindingSet(parsed["Unsupported active findings"], "Unsupported active findings");
    const findingIds = [...new Set([...verified, ...unsupported])].sort((left, right) => left.localeCompare(right, "en"));
    const correctionClaims = parseCanonicalPathSection(taskText, "Corrections Applied");
    lines.push(
      `- Findings cycle: ${parsed["Findings cycle"]}`,
      `- Finding IDs: ${findingIds.length === 0 ? "none" : findingIds.join(", ")}`,
      `- Findings verified: ${parsed["Findings verified"]}`,
      `- Corrections covered: ${correctionClaims.join(", ") || "none"}`,
      `- Regressions: ${scalar("Regressions selected", parsed["Regressions selected"])}`,
      `- Unsupported active findings: ${parsed["Unsupported active findings"]}`,
    );
  }
  return lines.join("\n");
}

function executionResponseFields(operation, parsed, testedScope) {
  const fields = { Operation: operation };
  for (const name of RESPONSE_FIELDS[operation].slice(1)) {
    fields[name] = name === "Tested scope" ? testedScope : parsed[name];
  }
  if (operation === "EXECUTE_SLICE" && parsed["Automatic check round"] !== "1/3") {
    fields["Prior-round failure"] = parsed["Prior-round failure"];
    fields["Correction applied"] = parsed["Correction applied"];
    fields["Correction paths"] = parsed.correctionPaths;
    fields["Updated scope"] = testedScope;
    fields["In-slice rationale"] = parsed["In-slice rationale"];
  }
  return fields;
}

export async function serializeRunnerExecutionBundleFromResponse({
  operation, response, workspace, taskArtifact,
}) {
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]).has(operation)) {
    fail("execution bundle operation must be EXECUTE_SLICE or APPLY_FINDINGS");
  }
  const payload = parseSemanticExecutionPayload(response, operation);
  await populateExecutionCorrectionClaims({
    workspace,
    taskArtifact,
    operation,
    round: Number(payload.automaticCheckRound.slice(0, -2)),
  });
  await serializeExecutionScopeClaims({ workspace, taskArtifact });
  const parsed = Object.fromEntries([
    ...MACHINE_EXECUTION_FIELDS[operation].map(([key, label]) => [label, payload[key]]),
    ["filelessReason", payload.filelessReason],
  ]);
  const targets = await deriveExecutionTargetsFromTask({ workspace, taskArtifact });
  const taskText = await fs.readFile(taskArtifact, "utf8");
  parsed.correctionPaths = parseCanonicalPathSection(taskText, "Corrections Applied").join(", ") || "none";
  const filelessReason = parsed.filelessReason ?? null;
  if (targets.length === 0 && filelessReason === null) fail("fileless semantic execution response must include Fileless reason");
  if (targets.length !== 0 && filelessReason !== null) fail("file-backed semantic execution response cannot include Fileless reason");
  const testedScope = targets.length === 0
    ? "none"
    : await canonicalTestedScope({ workspace, taskArtifact, targets });
  return serializeCanonicalExecutionCheck({
    operation,
    parsed,
    workspace,
    taskArtifact,
    targets,
    taskText,
    testedScope,
  });
}

export async function insertExecutionEvidenceInCandidate({ taskArtifact, operation, bundle }) {
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]).has(operation)
    || typeof bundle !== "string" || !/^### (?:implementation|findings)-check-[0-9]{2,}\n/u.test(bundle)) {
    fail("candidate insertion requires one canonical execution check");
  }
  const canonicalTask = await regularFile(taskArtifact, "candidate taskArtifact");
  const executionRoot = path.dirname(path.dirname(canonicalTask));
  const roots = [executionRoot, path.dirname(executionRoot)];
  let candidateRoot = null;
  for (const root of roots) {
    if (!path.basename(root).startsWith(".stnl-execution-copy-")) continue;
    if (await fs.access(path.join(root, ".stnl-execution-copy.json")).then(() => true).catch(() => false)) {
      candidateRoot = root;
      break;
    }
  }
  if (candidateRoot === null) fail("evidence insertion requires an owned isolated execution candidate");
  const markerFile = path.join(candidateRoot, ".stnl-execution-copy.json");
  await regularFile(markerFile, "candidate marker");
  const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
  const slice = path.basename(canonicalTask, ".md");
  const expectedTask = path.join(candidateRoot, executionRoot === candidateRoot ? "" : "execution", "tasks", `${slice}.md`);
  const allowedParents = typeof marker.specPath === "string"
    ? [path.dirname(marker.specPath), ...(path.basename(marker.specPath) === "feature_spec.md"
      ? [path.dirname(path.dirname(marker.specPath))] : [])]
    : [];
  if (!/^slice-[0-9]{2,}$/u.test(slice) || marker.slice !== slice || canonicalTask !== expectedTask
    || typeof marker.specPath !== "string" || !path.isAbsolute(marker.specPath)
    || !allowedParents.includes(path.dirname(candidateRoot))
    || typeof marker.executionRoot !== "string" || !path.isAbsolute(marker.executionRoot)
    || inside(candidateRoot, marker.executionRoot)) {
    fail("candidate task identity does not match its owned marker");
  }
  const expectedPrefix = operation === "EXECUTE_SLICE" ? "implementation-check" : "findings-check";
  if (!bundle.startsWith(`### ${expectedPrefix}-`)) fail("execution check type differs from operation");
  const section = operation === "EXECUTE_SLICE" ? "Implementation Test Evidence" : "Findings Test Evidence";
  const taskText = await fs.readFile(canonicalTask, "utf8");
  const heading = `## ${section}\n\n`;
  const start = taskText.indexOf(heading);
  if (start < 0 || taskText.indexOf(heading, start + heading.length) >= 0) fail("candidate evidence section is missing or duplicated");
  const bodyStart = start + heading.length;
  const end = taskText.indexOf("\n## ", bodyStart);
  if (end < 0) fail("candidate evidence section has no following section");
  const body = taskText.slice(bodyStart, end + 1);
  const identifier = bundle.split("\n", 1)[0];
  if (body.includes(identifier)) fail("candidate already contains this execution check");
  if (body !== "- none\n\n" && (!body.startsWith(`### ${expectedPrefix}-`) || !body.endsWith("\n\n"))) {
    fail("candidate evidence section is not appendable");
  }
  const replacement = body === "- none\n\n" ? `${bundle}\n\n` : `${body}${bundle}\n\n`;
  const updated = `${taskText.slice(0, bodyStart)}${replacement}${taskText.slice(end + 1)}`;
  const temporary = `${canonicalTask}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const mode = (await fs.stat(canonicalTask)).mode & 0o777;
    await fs.writeFile(temporary, updated, { flag: "wx", mode });
    await fs.rename(temporary, canonicalTask);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return identifier;
}

export async function prepareRunnerValidationPersistenceFromResponse({
  operation = "VALIDATE_SLICE", response, workspace, taskArtifact, specPath, slice, validationType,
}) {
  if (operation !== "VALIDATE_SLICE") fail("semantic validation producer operation must be VALIDATE_SLICE");
  const parsed = parseSemanticValidationPayload(response);
  const state = await inspectExecutionState(specPath);
  const selected = state.tasks?.get(canonicalSliceLabel(String(slice)));
  if (selected === undefined) fail("validation producer could not resolve the selected task");
  const derivedType = validationType ?? (selected.attempts.length === 0 ? "initial" : "revalidation");
  if (!new Set(["initial", "revalidation"]).has(derivedType)) {
    fail("validation producer Type must be initial or revalidation");
  }
  const targets = await deriveValidationTargetsFromTask({ workspace, taskArtifact });
  const verifiedScope = await canonicalTestedScope({ workspace, taskArtifact, targets });
  const commands = await canonicalValidationCommands({
    commands: parsed.commands,
    specPath,
    slice,
  });
  const findingFields = await canonicalValidationFindingFields({
    specPath,
    slice,
    state,
    status: parsed.status,
    findingReferences: parsed.findingReferences,
    findingDispositions: parsed.findingDispositions,
  });
  const values = [
    derivedType,
    parsed.status,
    verifiedScope,
    parsed.head,
    parsed.evidence,
    findingFields.findingReferences,
    findingFields.findingDispositions,
    parsed.blockers,
    parsed.unexpectedWorkspaceEffects,
    parsed.persistenceSummary,
  ];
  const [responseBlock, testedRecord, formalManifest] = await Promise.all([
    serializeRunnerResponse({ operation, values, workspace, taskArtifact, targets, commands }),
    serializeRunnerRecord({ workspace, taskArtifact, targets, commands }),
    serializeRunnerManifest({ workspace, taskArtifact, targets, commands }),
  ]);
  const bundle = `- Runner response:\n${responseBlock}\n- Tested record:\n${testedRecord}\n- Formal manifest:\n${formalManifest}`;
  const attemptNumber = selected.attempts.length + 1;
  const attemptId = `attempt-${String(attemptNumber).padStart(2, "0")}`;
  const serializedCommands = serializeCommands(commands);
  const attemptRecord = [
    `### ${attemptId}`,
    "",
    `- Type: ${derivedType}`,
    `- Status: ${parsed.status}`,
    `- HEAD: ${parsed.head}`,
    `- Verified scope: ${verifiedScope}`,
    `- Commands:\n${serializedCommands}`,
    `- Evidence: ${serializeMarkdownScalar("evidence", parsed.evidence, true)}`,
    `- Finding references: ${findingFields.findingReferences}`,
    `- Finding dispositions: ${validateScalarField("findingDispositions", findingFields.findingDispositions)}`,
    `- Blockers: ${serializeMarkdownScalar("blockers", parsed.blockers, true)}`,
    `- Unexpected workspace effects: ${serializeMarkdownScalar("unexpectedWorkspaceEffects", parsed.unexpectedWorkspaceEffects, true)}`,
    `- Persistence summary: ${serializeMarkdownScalar("persistenceSummary", parsed.persistenceSummary, true)}`,
  ].join("\n");
  const effectiveValidationBase = parsed.status === "PASS"
    ? [
      `- Origin attempt: ${attemptId}`,
      `- Attempt type: ${derivedType}`,
      `- HEAD: ${parsed.head}`,
      "- Result: PASS",
      formalManifest,
      `- Evidence summary: ${serializeMarkdownScalar("evidence", parsed.evidence, true)}`,
    ].join("\n")
    : null;
  return Object.freeze({
    status: parsed.status,
    type: derivedType,
    attemptId,
    attemptRecord,
    effectiveValidationBase,
    bundle,
  });
}

export async function serializeRunnerValidationBundleFromResponse(options) {
  const prepared = await prepareRunnerValidationPersistenceFromResponse(options);
  return prepared.bundle;
}

function argumentValues(tokens) {
  const values = { targets: [], removed: [], commands: [], semanticValues: [], record: false, response: false, manifest: false, executionBundle: false, validationBundle: false, insertCandidate: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index];
    if (name === "--record") {
      if (values.record) fail("duplicate --record");
      values.record = true;
      continue;
    }
    if (name === "--response") {
      if (values.response) fail("duplicate --response");
      values.response = true;
      continue;
    }
    if (name === "--manifest") {
      if (values.manifest) fail("duplicate --manifest");
      values.manifest = true;
      continue;
    }
    if (name === "--validation-bundle") {
      if (values.validationBundle) fail("duplicate --validation-bundle");
      values.validationBundle = true;
      continue;
    }
    if (name === "--execution-bundle") {
      if (values.executionBundle) fail("duplicate --execution-bundle");
      values.executionBundle = true;
      continue;
    }
    if (name === "--insert-candidate") {
      if (values.insertCandidate) fail("duplicate --insert-candidate");
      values.insertCandidate = true;
      continue;
    }
    if (name === "--command") {
      const exitIndex = tokens.indexOf("--exit", index + 1);
      if (exitIndex === -1 || exitIndex === index + 1) {
        fail(`--command requires a complete command followed by --exit <integer>`);
      }
      const command = tokens.slice(index + 1, exitIndex).join(" ");
      const exitValue = tokens[exitIndex + 1];
      if (exitValue === undefined || exitValue.startsWith("--")) {
        fail(`--command requires --exit <integer> for ${command}`);
      }
      if (!/^-?[0-9]+$/u.test(exitValue)) fail(`invalid command exit: ${exitValue}`);
      values.commands.push({ command, exit: Number(exitValue) });
      index = exitIndex + 1;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${name}`);
    if (name === "--workspace") {
      if (values.workspace !== undefined) fail("duplicate --workspace");
      values.workspace = value;
    } else if (name === "--task-artifact") {
      if (values.taskArtifact !== undefined) fail("duplicate --task-artifact");
      values.taskArtifact = value;
    } else if (name === "--spec-path") {
      if (values.specPath !== undefined) fail("duplicate --spec-path");
      values.specPath = value;
    } else if (name === "--slice") {
      if (values.slice !== undefined) fail("duplicate --slice");
      values.slice = value;
    } else if (name === "--target") {
      values.targets.push(value);
    } else if (name === "--removed") {
      values.removed.push(value);
    } else if (name === "--operation") {
      if (values.operation !== undefined) fail("duplicate --operation");
      values.operation = value;
    } else if (name === "--value") {
      values.semanticValues.push(value);
    } else if (name === "--fileless-reason") {
      if (values.filelessReason !== undefined) fail("duplicate --fileless-reason");
      values.filelessReason = value;
    } else if (name === "--semantic-response-file") {
      if (values.semanticResponseFile !== undefined) fail("duplicate --semantic-response-file");
      if (!path.isAbsolute(value)) fail("--semantic-response-file must be absolute");
      values.semanticResponseFile = value;
    } else {
      fail(`unknown option ${name}`);
    }
    index += 1;
  }
  if (values.workspace === undefined) fail("--workspace is required");
  const hasExplicitTaskArtifact = values.taskArtifact !== undefined;
  const hasDerivedTaskInputs = values.specPath !== undefined || values.slice !== undefined;
  if (hasExplicitTaskArtifact && hasDerivedTaskInputs) fail("use --task-artifact or --spec-path with --slice, not both");
  if (!hasExplicitTaskArtifact && (values.specPath === undefined || values.slice === undefined)) {
    fail("--task-artifact or --spec-path with --slice is required");
  }
  if ([values.record, values.response, values.manifest, values.executionBundle, values.validationBundle].filter(Boolean).length > 1) {
    fail("--record, --response, --manifest, --execution-bundle, and --validation-bundle are mutually exclusive");
  }
  if (!values.record && !values.response && !values.manifest && !values.executionBundle && !values.validationBundle) {
    fail("one of --record, --response, --manifest, --execution-bundle, or --validation-bundle is required");
  }
  if (values.response && values.operation === undefined) fail("--operation is required for --response");
  if (values.executionBundle && !new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]).has(values.operation)) {
    fail("--execution-bundle requires --operation EXECUTE_SLICE or APPLY_FINDINGS");
  }
  if (values.executionBundle && values.semanticResponseFile === undefined) {
    fail("--execution-bundle requires --semantic-response-file");
  }
  if (values.insertCandidate && (!values.executionBundle || !hasExplicitTaskArtifact)) {
    fail("--insert-candidate requires --execution-bundle and --task-artifact");
  }
  if (values.validationBundle && values.operation !== "VALIDATE_SLICE") {
    fail("--validation-bundle requires --operation VALIDATE_SLICE");
  }
  if (values.semanticResponseFile !== undefined && !values.validationBundle && !values.executionBundle) {
    fail("--semantic-response-file requires --execution-bundle or --validation-bundle");
  }
  if (values.semanticResponseFile !== undefined && (values.semanticValues.length !== 0 || values.targets.length !== 0 || values.removed.length !== 0 || values.commands.length !== 0)) {
    fail("--semantic-response-file cannot be combined with semantic values, targets, removals, or commands");
  }
  if (values.validationBundle && values.semanticResponseFile !== undefined && (values.specPath === undefined || values.slice === undefined)) {
    fail("--semantic-response-file requires --spec-path and --slice so the producer can derive validation Type");
  }
  return values;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write(CLI_HELP);
      process.exit(0);
    }
    const values = argumentValues(process.argv.slice(2));
    if (values.taskArtifact === undefined) values.taskArtifact = await deriveTaskArtifact(values);
    if (values.response) {
      process.stdout.write(`${await serializeRunnerResponse({ ...values, values: values.semanticValues })}\n`);
    } else if (values.executionBundle) {
      const bundle = await serializeRunnerExecutionBundleFromResponse({
        operation: values.operation,
        response: await fs.readFile(values.semanticResponseFile, "utf8"),
        workspace: values.workspace,
        taskArtifact: values.taskArtifact,
      });
      if (values.insertCandidate) {
        const identifier = await insertExecutionEvidenceInCandidate({
          taskArtifact: values.taskArtifact, operation: values.operation, bundle,
        });
        process.stdout.write(`${identifier} inserted into isolated candidate\n`);
      } else process.stdout.write(`${bundle}\n`);
    } else if (values.validationBundle) {
      const bundle = values.semanticResponseFile === undefined
        ? await serializeRunnerValidationBundle({ ...values, values: values.semanticValues })
        : await serializeRunnerValidationBundleFromResponse({
          operation: values.operation,
          response: await fs.readFile(values.semanticResponseFile, "utf8"),
          workspace: values.workspace,
          taskArtifact: values.taskArtifact,
          specPath: values.specPath,
          slice: values.slice,
        });
      process.stdout.write(`${bundle}\n`);
    } else if (values.manifest) {
      process.stdout.write(`${await serializeRunnerManifest(values)}\n`);
    } else if (values.record) {
      process.stdout.write(`${await serializeRunnerRecord(values)}\n`);
    } else {
      process.stdout.write(`${await serializeRunnerEvidence(values)}\n`);
    }
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
