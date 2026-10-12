#!/usr/bin/env node
import { assertExecutionAttempt, assertOwnedOperationalCandidate, readOwnedFile, executionLockIdentity, withExecutionPublicationLock } from './execution-publication.mjs';

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectExecutionState,
  resolveExecutionWorkspace, readExecutionActivation, readDeliveryContinuity, readDeliveryHistory } from "./execution-state.mjs";
import { resolveRunnerCommandEvents } from "./runner-command-events.mjs";
import { assertManagedRunnerReceipt } from "./managed-slice-context.mjs";

import { preparationAreaClaims, parseStrictJson } from './execution-preparation.mjs';

function fail(message) {
  throw new Error(message);
}

export class RunnerVerdictEvidenceError extends Error {
  constructor(operation, status, failedCommands, message = null) {
    super(message ?? `${operation} ${status} contradicts ${failedCommands.length} marked verification command(s) with non-zero exit`);
    this.name = "RunnerVerdictEvidenceError";
    this.code = "RUNNER_VERDICT_EVIDENCE_CONFLICT";
    this.operation = operation;
    this.status = status;
    this.failedCommands = failedCommands;
  }
}

export class RunnerSemanticResultError extends Error {
  constructor(operation, cause) {
    super(`${operation} captured semantic result is invalid: ${cause.message}`, { cause });
    this.name = "RunnerSemanticResultError";
    this.code = "RUNNER_SEMANTIC_RESULT_INVALID";
  }
}

function parseCapturedResult(operation, parse, response) {
  try { return parse(response, operation); }
  catch (error) { throw new RunnerSemanticResultError(operation, error); }
}

async function requireAcceptedRunnerResult(options) {
  const context = await assertManagedRunnerReceipt({ ...options, allowRejected: true });
  if (options.receiptFile === undefined) return;
  const receipt = JSON.parse(await fs.readFile(options.receiptFile, "utf8"));
  if (options.response !== undefined && options.response !== await fs.readFile(options.semanticResponseFile, "utf8")) fail("semantic response differs from captured runner bytes");
  if (receipt.status === "RUNNER_RESULT_BLOCKED") {
    if (context === null) fail("rejected runner diagnostics require a matching active managed invocation");
    // Identity and conclusion passed; semantic rejection can produce only a
    // Delegation Blocker, never commands, a check, an attempt, or PASS.
    throw new RunnerSemanticResultError(options.operation,
      Object.assign(new Error(receipt.captureFailure), { code: receipt.captureFailureCode }));
  }
  return receipt;
}

export function recoverableRunnerResultDiagnostic(error) {
  if (!(error instanceof RunnerVerdictEvidenceError || error instanceof RunnerSemanticResultError)) return null;
  const failed = error instanceof RunnerVerdictEvidenceError
    ? `; failed verification commands: ${JSON.stringify(error.failedCommands)}` : "";
  return `${error.code}: ${error.message}${failed}`;
}

export function assertRunnerVerdictConsistency(operation, status, commands) {
  const success = operation === "VALIDATE_SLICE" ? status === "PASS" : status === "TESTS_PASS";
  if (!success) return;
  const failed = commands.filter(({ exit }) => exit !== 0);
  if (failed.length !== 0) throw new RunnerVerdictEvidenceError(operation, status, failed);
}

const CLI_HELP = `Usage:
  serialize-runner-evidence.mjs --execution-bundle --operation <EXECUTE_SLICE|APPLY_FINDINGS> --workspace <absolute> (--task-artifact <absolute> | --spec-path <absolute> --slice <slice>) --semantic-response-file <absolute> [--receipt-file <absolute> --insert-candidate]
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

async function rejectWorkspaceSymlinkComponents(candidate, workspaceRoot) {
  if (!inside(candidate, workspaceRoot)) fail(`validation-owned path escapes its trusted workspace: ${candidate}`);
  let current = workspaceRoot;
  for (const component of path.relative(workspaceRoot, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const metadata = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (metadata === null) return;
    if (metadata.isSymbolicLink()) fail(`validation-owned path traverses a symlink: ${current}`);
  }
}

function normalizedRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(`${label} must be a normalized relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value === ".") fail(`${label} must be a normalized relative path`);
  return value;
}

async function regularFile(file, label, workspaceRoot = null) {
  if (workspaceRoot !== null) await rejectWorkspaceSymlinkComponents(file, workspaceRoot);
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

async function proveRemoval({ workspaceRoot, taskArtifact, claim, expected = null }) {
  const target = path.resolve(path.dirname(taskArtifact), claim);
  await rejectWorkspaceSymlinkComponents(target, workspaceRoot);
  if (!inside(target, workspaceRoot) || await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('removal requires a currently absent contained file');
  let previous = await capturedBeforeRemoval({ workspaceRoot, taskArtifact, claim, expected });
  if (previous === null) {
    const executionRoot = path.dirname(path.dirname(taskArtifact));
    let marker = null;
    for (const file of [`${executionRoot}.copy.json`, `${path.dirname(executionRoot)}.copy.json`, `${executionRoot}.publication.json`]) {
      try { marker = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const local = (await readOwnedFile(taskArtifact)).bytes.toString('utf8');
    const reference = local.match(/^- Requirements source: `([^`]+)`$/mu)?.[1];
    if (!marker && !reference) fail('removal proof requires canonical requirements authority');
    const specPath = marker?.specPath ?? path.resolve(path.dirname(taskArtifact), reference);
    const official = await resolveExecutionWorkspace(specPath);
    if (marker) await assertPrivateTask(taskArtifact);
    else if (taskArtifact !== path.join(official.executionRoot, 'tasks', path.basename(taskArtifact))) fail('removal proof must come from official history');
    await readExecutionActivation(specPath);
    const historical = (await readOwnedFile(path.join(official.executionRoot, 'tasks', path.basename(taskArtifact)))).bytes.toString('utf8');
    const escaped = claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    for (const heading of ['Implementation Test Evidence', 'Findings Test Evidence']) {
      const section = sectionBody(historical, heading);
      for (const state of section.matchAll(/^- Tested state:\n((?:  - [^\n]+\n?)+)/gmu)) {
        previous = [...state[1].matchAll(new RegExp('^  - `' + escaped + '` \\| (sha256:[a-f0-9]{64})$', 'gmu'))].at(-1)?.[1] ?? previous;
      }
      // A first removal has no earlier published SHA. Its terminal record is
      // the authority anchor for the retained actual before capture, so later
      // formal consumers can still verify it after ownership has closed.
      for (const record of section.split(/(?=^### (?:implementation|findings)-check-[0-9]+$)/mu)) {
        if (!record.includes(`  - \`${claim}\` | REMOVED`)) continue;
        const operationAttemptId = record.match(/^- Operation attempt ID: ([a-f0-9-]+)$/mu)?.[1];
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(operationAttemptId ?? '')) continue;
        const { lockPath } = await executionLockIdentity(official);
        const directory = `${lockPath}.before-${operationAttemptId}`;
        const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const name of files.filter(name => name.startsWith(removalCapturePrefix(claim) + '-'))) {
          const capture = parseStrictJson((await readOwnedFile(path.join(directory, name))).bytes.toString('utf8'));
          const fields = [['deliveryId','Delivery ID'],['preparationRevision','Preparation revision'],['normativeSha256','Normative sha256'],['operationAttemptId','Operation attempt ID'],['originActivationId','Origin activation ID']];
          if (capture.taskArtifact !== path.join(official.executionRoot, 'tasks', path.basename(taskArtifact))
            || capture.workspace !== workspaceRoot || capture.path !== claim
            || !/^sha256:[a-f0-9]{64}$/u.test(capture.previousSha256)
            || name !== `${removalCapturePrefix(claim)}-${capture.previousSha256.slice(7)}.json`
            || fields.some(([key,label]) => !record.includes(`- ${label}: ${capture.owner?.[key]}\n`))) fail('published removal before capture binding differs');
          if (expected === null || expected === capture.previousSha256) previous = capture.previousSha256;
        }
      }
    }
  }
  if (previous === null || (expected !== null && expected !== previous)) fail('absent future file is not proved removal');
  return previous;
}

async function canonicalEvidenceEntries({ workspace, taskArtifact, targets = [], removed = [] }) {
  if (!Array.isArray(targets) || !Array.isArray(removed)) fail("targets and removed must be arrays");
  if (targets.length === 0 && removed.length === 0) fail("at least one semantic evidence target is required");

  const workspaceRoot = await canonicalWorkspacePath(workspace);
  if (!path.isAbsolute(taskArtifact)) fail("taskArtifact must be absolute");
  if (!inside(taskArtifact, workspaceRoot)) fail("taskArtifact must belong to workspace");
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact", workspaceRoot);
  if (!inside(canonicalTask, workspaceRoot)) fail("taskArtifact must belong to workspace");

  const entries = [];
  const claims = new Set();
  const physical = new Set();
  for (const target of targets) {
    if (typeof target !== "string" || !path.isAbsolute(target)) fail("file-backed targets must be absolute");
    if (!inside(target, workspaceRoot)) fail("file-backed target must belong to workspace");
    const canonicalTarget = await regularFile(target, "file-backed target", workspaceRoot);
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
    await proveRemoval({workspaceRoot,taskArtifact:canonicalTask,claim});
    claims.add(claim);
    entries.push({ claim, value: "REMOVED" });
  }
  return entries.sort((left, right) => left.claim.localeCompare(right.claim, "en"));
}

// Capture before control returns to the author. The producer may select a
// subset later, but it must never read the workspace to reconstruct this round.
export async function captureRunnerTestedState({ workspace, taskArtifact, changedAreas = null, removedProofs = [] }) {
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  if (!inside(taskArtifact, workspaceRoot)) fail("source taskArtifact must belong to workspace");
  const sourceTaskPath = await regularFile(taskArtifact, "source taskArtifact", workspaceRoot);
  if (!inside(sourceTaskPath, workspaceRoot)) fail("source taskArtifact must belong to workspace");
  const taskText = await fs.readFile(sourceTaskPath, "utf8");
  const claims = changedAreas === null
    ? parseCanonicalPathSection(taskText, "Changed Areas")
    : changedAreas;
  if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== "string")) {
    fail("runner changedAreas must be a path array");
  }
  const approvedTargets = await canonicalApprovedTargets({ workspaceRoot, taskArtifact: sourceTaskPath, taskText });
  const targets = []; const removed = [];
  for (const raw of [...new Set(claims)]) {
    const claim = await canonicalizeScopeClaim({ workspaceRoot, taskArtifact: sourceTaskPath, approvedTargets, raw, heading: 'runner changed area' });
    const physical = await existingPhysicalCandidate(path.resolve(path.dirname(sourceTaskPath), claim), 'runner task-relative target', workspaceRoot);
    if (physical) targets.push(physical);
    else {
      const proof = removedProofs.find(entry => entry.path === claim);
      await proveRemoval({workspaceRoot,taskArtifact:sourceTaskPath,claim,expected:proof?.previousSha256 ?? null});
      removed.push(claim);
    }
  }
  const entries = claims.length === 0 ? [] : await canonicalEvidenceEntries({
    workspace: workspaceRoot, taskArtifact: sourceTaskPath, targets, removed,
  });
  await retainBeforeRemoval({ workspaceRoot, taskArtifact: sourceTaskPath, entries });
  return { workspace: workspaceRoot, sourceTaskPath, entries: entries.map(({ claim, value }) => ({ path: claim, value })) };
}

async function removalCaptureAuthority(taskArtifact) {
  const executionRoot = path.dirname(path.dirname(taskArtifact));
  let specPath;
  for (const file of [`${executionRoot}.copy.json`, `${path.dirname(executionRoot)}.copy.json`, `${executionRoot}.publication.json`]) {
    try {
      const marker = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
      await assertPrivateTask(taskArtifact); specPath = marker.specPath; break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!specPath) {
    const text = (await readOwnedFile(taskArtifact)).bytes.toString('utf8');
    const reference = text.match(/^- Requirements source: `([^`]+)`$/mu)?.[1];
    if (!reference) fail('capture requires canonical requirements authority');
    specPath = path.resolve(path.dirname(taskArtifact), reference);
  }
  const workspace = await resolveExecutionWorkspace(specPath);
  const officialTask = path.join(workspace.executionRoot, 'tasks', path.basename(taskArtifact));
  if (executionRoot === workspace.executionRoot && taskArtifact !== officialTask) fail('capture task identity differs');
  const owner = (await readExecutionActivation(specPath)).activation.activeAttempt;
  const { lockPath } = await executionLockIdentity(workspace);
  const directory = owner ? `${lockPath}.before-${owner.operationAttemptId}` : null;
  return { workspace, specPath, officialTask, owner, directory };
}

const removalCapturePrefix = claim => createHash('sha256').update(claim).digest('hex');

async function retainBeforeRemoval({ workspaceRoot, taskArtifact, entries }) {
  const authority = await removalCaptureAuthority(taskArtifact);
  if (!authority.owner) return; // Historical read-only capture remains useful.
  await withExecutionPublicationLock(authority.workspace, async () => {
    assertExecutionAttempt((await readExecutionActivation(authority.specPath)).activation, authority.owner);
    await fs.mkdir(authority.directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const metadata = await fs.lstat(authority.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('unsafe before-removal capture directory');
    for (const entry of entries.filter(entry => entry.value.startsWith('sha256:'))) {
      const target = path.resolve(path.dirname(taskArtifact), entry.claim);
      const observed = await readOwnedFile(await regularFile(target, 'before-removal file', workspaceRoot));
      if (`sha256:${createHash('sha256').update(observed.bytes).digest('hex')}` !== entry.value) fail('file changed during before-removal capture');
      const { runner: _runner, ...captureOwner } = authority.owner;
      const record = { owner: captureOwner, taskArtifact: authority.officialTask, workspace: workspaceRoot, path: entry.claim, previousSha256: entry.value };
      const file = path.join(authority.directory, `${removalCapturePrefix(entry.claim)}-${entry.value.slice(7)}.json`);
      const bytes = JSON.stringify(record, null, 2) + '\n';
      try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || (await readOwnedFile(file)).bytes.toString('utf8') !== bytes) throw error;
      }
    }
  });
}

async function capturedBeforeRemoval({ workspaceRoot, taskArtifact, claim, expected }) {
  const authority = await removalCaptureAuthority(taskArtifact);
  if (!authority.owner || authority.owner.slice !== path.basename(taskArtifact, '.md')) return null;
  const files = await fs.readdir(authority.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of files.filter(name => name.startsWith(removalCapturePrefix(claim) + '-')).sort()) {
    const record = parseStrictJson((await readOwnedFile(path.join(authority.directory, name))).bytes.toString('utf8'));
    assertExecutionAttempt((await readExecutionActivation(authority.specPath)).activation, record.owner);
    if (record.taskArtifact !== authority.officialTask || record.workspace !== workspaceRoot || record.path !== claim
      || !/^sha256:[a-f0-9]{64}$/u.test(record.previousSha256)
      || name !== `${removalCapturePrefix(claim)}-${record.previousSha256.slice(7)}.json`) fail('before-removal capture binding differs');
    if (expected === null || expected === record.previousSha256) return record.previousSha256;
  }
  return null;
}

import { assertRunnerVerification } from './runner-verification.mjs';

export async function resolveCapturedRunnerCommands(options, nativeCommands) {
  const receipt = options.receiptFile ? JSON.parse((await readOwnedFile(options.receiptFile)).bytes.toString('utf8')) : null;
  if (!receipt?.verification) fail('official runner receipt has no reviewed verification recipe');
  const commands = assertRunnerVerification(receipt.verification, receipt.verification.verification);
  if (receipt.transport === 'native' && JSON.stringify(nativeCommands) !== JSON.stringify(commands)) fail('native response commands differ from reviewed recipe observation');
  if (receipt.transport !== 'native') {
    const events = await resolveRunnerCommandEvents(options);
    if (events.length) fail('additional SDK verification commands require an explicitly reviewed recipe; preserve the observed events');
  }
  return commands;
}

// Validate prospective scope before allocating a runner turn. Execution edits
// an isolated candidate: live Changed Areas can be pending or describe a prior
// attempt. Do not require publishing those edits before collecting their tests.
// The receipt captures this scope; capturedExecutionEntries and strict candidate
// validation enforce its exact agreement with the candidate before publication.
export async function validateManagedChangedAreas({ workspace, taskArtifact, changedAreas }) {
  if (!Array.isArray(changedAreas)) fail("managed changedAreas must be an array");
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  if (!inside(taskArtifact, workspaceRoot)) fail("source taskArtifact must belong to workspace");
  const sourceTaskPath = await regularFile(taskArtifact, "source taskArtifact", workspaceRoot);
  if (!inside(sourceTaskPath, workspaceRoot)) fail("source taskArtifact must belong to workspace");
  const taskText = await fs.readFile(sourceTaskPath, "utf8");
  const approvedTargets = await canonicalApprovedTargets({ workspaceRoot, taskArtifact: sourceTaskPath, taskText });
  const normalized = [];
  for (const raw of changedAreas) {
    const claim = await canonicalizeScopeClaim({ workspaceRoot, taskArtifact: sourceTaskPath,
      approvedTargets, raw, heading: "managed changedAreas" });
    if (raw !== claim) fail("managed changedAreas must use canonical task-relative path claims");
    if (!normalized.includes(claim)) normalized.push(claim);
  }
  normalized.sort((left, right) => left.localeCompare(right, "en"));
  return normalized;
}

async function canonicalTestedScope({ workspace, taskArtifact, targets = [], removed = [] }) {
  const entries = await canonicalEvidenceEntries({ workspace, taskArtifact, targets, removed });
  return entries.map(({ claim }) => claim).join(", ");
}

function serializeCommand(command, label) {
  if (typeof command !== "string" || command.length === 0) fail(`${label} must be a non-empty command`);
  return /[`\r\n]/u.test(command) ? `json:${JSON.stringify(command)}` : `\`${command}\``;
}

function decodeCommand(value, label) {
  if (value.startsWith("json:")) {
    let command;
    try { command = JSON.parse(value.slice(5)); } catch { fail(`${label} must use a canonical json-quoted command`); }
    if (typeof command !== "string" || command.length === 0
      || serializeCommand(command, label) !== value) fail(`${label} must use a canonical json-quoted command`);
    return command;
  }
  const match = value.match(/^`([^`\r\n]+)`$/u);
  if (match === null) fail(`${label} is malformed`);
  return match[1];
}

function serializeCommands(commands) {
  if (!Array.isArray(commands)) fail("commands must be an array");
  return commands.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`command ${index + 1} must be an object`);
    }
    serializeCommand(entry.command, `command ${index + 1}`);
    if (!Number.isSafeInteger(entry.exit)) fail(`command ${index + 1} exit must be an integer`);
    return `  - ${serializeCommand(entry.command, `command ${index + 1}`)} | exit:${entry.exit}`;
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
  "In-slice rationale", "Evidence", "Evidence or failure summary", "Affected files or behaviors", "Blockers",
  "Unexpected workspace effects", "Persistence summary", "Regressions selected", "Corrections covered", "Fileless reason",
]);

const EXPLANATORY_VALIDATION_FIELDS = new Set([
  "evidence", "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
]);

function serializeMarkdownScalar(name, value, explanatory = false) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty scalar`);
  if (!explanatory) return validateScalarField(name, value);
  return /[`\r\n]/u.test(value) || value.startsWith("json:") ? `json:${JSON.stringify(value)}` : value;
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
  if (typeof decoded !== "string" || decoded.length === 0
    || serializeMarkdownScalar(name, decoded, true) !== value) {
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

async function evidenceBinding(taskArtifact, evidenceOwner = null) {
  let specPath;
  const executionRoot = path.dirname(path.dirname(taskArtifact));
  for (const root of [executionRoot, path.dirname(executionRoot)]) {
    const marker = await fs.readFile(`${root}.copy.json`, 'utf8').then(parseStrictJson).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (marker) { specPath = marker.specPath; break; }
  }
  if (!specPath) {
    const text = await fs.readFile(taskArtifact, 'utf8');
    const source = text.match(/^- Requirements source: `([^`]+)`$/mu)?.[1];
    if (!source) fail('evidence requires an existing requirements reference');
    specPath = path.resolve(path.dirname(taskArtifact), source);
  }
  const activated = await readExecutionActivation(specPath);
  const owner = activated.activation.activeAttempt;
  if (!owner || owner.slice !== path.basename(taskArtifact, '.md')) fail('evidence requires an admitted operation owner');
  if (evidenceOwner) { assertExecutionAttempt(activated.activation, evidenceOwner); }
  const origin = evidenceOwner ?? owner;
  return `- Delivery ID: ${origin.deliveryId}\n- Preparation revision: ${origin.preparationRevision}\n- Normative sha256: ${origin.normativeSha256}\n- Operation attempt ID: ${origin.operationAttemptId}\n- Origin activation ID: ${origin.originActivationId}`;
}

export async function serializeRunnerRecord({ workspace, taskArtifact, targets = [], removed = [], capturedEntries = null, evidenceOwner = null, commands = [], filelessReason = null, allowEmptyCommands = false }) {
  const hasFileBackedState = capturedEntries !== null ? capturedEntries.length !== 0 : targets.length !== 0 || removed.length !== 0;
  let testedState;
  if (hasFileBackedState) {
    if (filelessReason !== null) fail("filelessReason is only valid for a fileless state");
    testedState = capturedEntries === null
      ? await serializeRunnerEvidence({ workspace, taskArtifact, targets, removed, commands })
      : capturedEntries.map(({ path: claim, value }) => `  - \`${claim}\` | ${value}`).join("\n");
  } else {
    testedState = `- Tested state: none\n- Fileless reason: ${serializeMarkdownScalar("filelessReason", filelessReason ?? "", true)}`;
  }
  const serializedCommands = serializeCommands(commands);
  if (serializedCommands.length === 0 && !allowEmptyCommands) fail("at least one executed command is required");
  const commandBlock = serializedCommands.length === 0 ? "- Commands: none" : `- Commands:\n${serializedCommands}`;
  const binding = await evidenceBinding(taskArtifact, evidenceOwner);
  return `${binding}\n${hasFileBackedState ? `- Tested state:\n${testedState}` : testedState}\n${commandBlock}`;
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
        const match = lines[cursor].match(/^  - (.+) \| exit:(-?[0-9]+)$/u);
        if (match === null) fail("semantic execution response contains a malformed command tuple");
        commands.push({ command: decodeCommand(match[1], "semantic execution command"), exit: Number(match[2]) });
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

export function parseSemanticExecutionPayload(text, operation, { automaticCheckRound } = {}) {
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
  if (!["TESTS_PASS", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"].includes(payload.status)) {
    fail("semantic execution payload Status is invalid");
  }
  // The managed caller supplies the broker-admitted round. The raw echo stays
  // unchanged in its captured artifact and has no bookkeeping authority.
  if (automaticCheckRound !== undefined) {
    if (!["1/3", "2/3", "3/3"].includes(automaticCheckRound)) fail("admitted automatic check round is invalid");
    payload = { ...payload, automaticCheckRound };
  }
  if (!["1/3", "2/3", "3/3"].includes(payload.automaticCheckRound)) {
    fail("semantic execution payload Automatic check round is invalid");
  }
  const allowed = new Set([...fields.map(([key]) => key), "filelessReason", ...(operation === "APPLY_FINDINGS" ? ["findingsCycle"] : [])]);
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
    serializeCommand(command.command, `semantic execution payload command ${index + 1}`);
    if (!Number.isSafeInteger(command.exit)) fail(`semantic execution payload command ${index + 1} exit must be an integer`);
  }
  if (payload.commands.length === 0 && !new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(payload.status)) {
    fail("non-blocked semantic execution payload requires executed commands");
  }
  if (operation === "EXECUTE_SLICE" && payload.automaticCheckRound !== "1/3") {
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

export function parseSemanticValidationPayload(text) {
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
    serializeCommand(command.command, `semantic validation payload command ${index + 1}`);
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
    if (expected[1].replace(/`[^`\n]+`/gu, "").includes("`")) fail("Checklist expected areas contain an unmatched path delimiter");
    claims.push(...lineClaims);
  }
  return claims;
}

async function existingPhysicalCandidate(candidate, label, workspaceRoot) {
  await rejectWorkspaceSymlinkComponents(candidate, workspaceRoot);
  const metadata = await fs.lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") return null;
    fail(`${label} is not available: ${error.message}`);
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return fs.realpath(candidate);
}

async function canonicalApprovedTargets({ workspaceRoot, taskArtifact, taskText }) {
  const areas = preparationAreaClaims(sectionBody(taskText, 'Authorized Areas'));
  const targets = new Map(); const directories = [];
  for (const area of areas) {
    const candidate = path.resolve(path.dirname(taskArtifact), area.path);
    await rejectWorkspaceSymlinkComponents(candidate, workspaceRoot);
    if (area.kind === 'directory') directories.push(candidate);
    else targets.set(candidate, area.path);
  }
  return { targets, directories };
}

async function canonicalizeScopeClaim({ workspaceRoot, taskArtifact, approvedTargets, raw, heading }) {
  const claim = normalizedRelative(raw, `${heading} path`);
  const physical = path.resolve(path.dirname(taskArtifact), claim);
  await rejectWorkspaceSymlinkComponents(physical, workspaceRoot);
  if (!approvedTargets.targets.has(physical) && !approvedTargets.directories.some(directory => inside(physical, directory))) fail(`${heading} is outside authorized areas: ${claim}`);
  const metadata = await fs.lstat(physical).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)) fail(`${heading} must identify a real single-link file or explicitly proved removal`);
  return claim;
}

async function privateTaskAuthority(taskArtifact) {
  return assertOwnedOperationalCandidate({ candidateExecutionRoot: path.dirname(path.dirname(taskArtifact)),
    slice: path.basename(taskArtifact, '.md'), resolveWorkspace: resolveExecutionWorkspace, readActivated: readExecutionActivation });
}
async function assertPrivateTask(taskArtifact) {
  return (await privateTaskAuthority(taskArtifact)).marker;
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
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact", workspaceRoot);
  if (!inside(canonicalTask, workspaceRoot)) fail("taskArtifact must belong to workspace");
  await assertPrivateTask(canonicalTask);
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
  let recordPaths = new Set();
  for (const line of body.split("\n")) {
    if (/^### overlap-[0-9]+$/u.test(line)) recordPaths = new Set();
    const canonicalMatch = line.match(/^- Paths: (.+)$/u);
    const semanticMatch = line.match(/^- Slice [0-9]+ overlap: (.+?); (.+)$/u);
    if (canonicalMatch === null && semanticMatch === null) continue;
    if (semanticMatch !== null) recordPaths = new Set();
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
      if (recordPaths.has(claim)) fail(`Prior Validation Overlap contains duplicate path claim: ${claim}`);
      recordPaths.add(claim);
      paths.push(claim);
    }
  }
  if (paths.length === 0) fail("Prior Validation Overlap must contain canonical Paths claims or - none");
  return paths;
}

function inheritedSupersededClaims(state, selectedSlice, declared) {
  if (state.rows.at(-1)?.slice !== selectedSlice) return new Map();
  const unowned = new Set(state.supersededUnowned);
  const inherited = new Map();
  for (const row of state.rows.filter((entry) => entry.result === "SUPERSEDED")) {
    const origin = state.tasks.get(row.slice);
    for (const claim of origin.claims) {
      if (!unowned.has(`${row.slice}:${claim}`) || declared.has(claim)) continue;
      let successor = row.slice;
      const visited = new Set();
      while (successor !== selectedSlice) {
        if (visited.has(successor)) fail(`superseded path has cyclic recovery lineage: ${claim}`);
        visited.add(successor);
        const task = state.tasks.get(successor);
        if (task?.final.result !== "SUPERSEDED") fail(`superseded path is outside selected recovery lineage: ${claim}`);
        successor = task.final.supersededBy;
      }
      inherited.set(claim, origin);
    }
  }
  const expected = new Map();
  for (const [claim, origin] of inherited) {
    const check = origin.currentAuxiliaryCheck;
    const proof = check?.testedState.find((entry) => entry.path === claim);
    if (!check?.commands.some((entry) => entry.exit === 0) || !/^sha256:[0-9a-f]{64}$/u.test(proof?.expected ?? "")) {
      fail(`superseded path lacks tested file evidence: ${claim}`);
    }
    expected.set(claim, proof.expected);
  }
  return expected;
}

async function deriveValidationTargetsFromTask({ workspace, taskArtifact, filelessReason = null, state = null, selectedSlice = null }) {
  const taskText = await fs.readFile(taskArtifact, "utf8");
  const claims = [
    ...parseCanonicalPathSection(taskText, "Changed Areas"),
    ...parseOverlapPathSection(taskText),
  ];
  const inherited = state === null ? new Map() : inheritedSupersededClaims(state, selectedSlice, new Set(claims));
  claims.push(...inherited.keys());
  const uniqueClaims = [];
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim)) continue;
    seen.add(claim);
    uniqueClaims.push(claim);
  }
  if (uniqueClaims.length === 0 && filelessReason === null) fail("validation producer cannot derive a file-backed target set from the task artifact");
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  if (inherited.size !== 0 && await regularFile(taskArtifact, "taskArtifact", workspaceRoot)
    !== await regularFile(path.join(state.workspace.executionRoot, "tasks", `${selectedSlice}.md`), "live taskArtifact", workspaceRoot)) {
    fail("inherited superseded paths require the selected live task authority");
  }
  const targets = []; const removed = [];
  for (const claim of uniqueClaims) {
    const physical = path.resolve(path.dirname(taskArtifact), claim);
    if (!inside(physical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
    const canonical = await existingPhysicalCandidate(physical, `task claim ${claim}`, workspaceRoot);
    if (canonical === null) {
      await proveRemoval({ workspaceRoot, taskArtifact, claim });
      if (inherited.has(claim)) fail('superseded removal requires its original evidence authority');
      removed.push(claim); continue;
    }
    if (!inside(canonical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
    const historical = inherited.get(claim);
    if (historical !== undefined && `sha256:${createHash("sha256").update(await fs.readFile(canonical)).digest("hex")}` !== historical) {
      fail(`superseded path drifted from tested file evidence: ${claim}`);
    }
    if (historical !== undefined) inherited.set(claim, { expected: historical, target: canonical });
    targets.push(canonical);
  }
  return { targets, removed, inherited };
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
  const removed = [];
  for (const claim of uniqueClaims) {
    const physical = path.resolve(path.dirname(taskArtifact), claim);
    if (!inside(physical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
    const canonical = await existingPhysicalCandidate(physical, `task claim ${claim}`, workspaceRoot);
    if (canonical === null) {
      if (!inside(physical, workspaceRoot) || !inside(await fs.realpath(path.dirname(physical)), workspaceRoot)) {
        fail(`task claim resolves outside workspace: ${claim}`);
      }
      await proveRemoval({workspaceRoot,taskArtifact,claim});
      removed.push(claim);
    } else {
      if (!inside(canonical, workspaceRoot)) fail(`task claim resolves outside workspace: ${claim}`);
      targets.push(canonical);
    }
  }
  return { targets, removed };
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
  const correctionClaims = records.flatMap((entry) => {
    const value = entry.match(/^- Correction paths: (.+)$/mu)?.[1];
    return value === undefined || value === "none" ? []
      : value.split(", ").map((claim) => normalizedRelative(claim, "historical Correction paths"));
  });
  return { testedState, correctionClaims };
}

async function populateExecutionCorrectionClaims({ workspace, taskArtifact, operation, round }) {
  if (operation !== "EXECUTE_SLICE" || round === 1) return;
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const canonicalTask = await regularFile(taskArtifact, "taskArtifact", workspaceRoot);
  await assertPrivateTask(canonicalTask);
  const before = await fs.readFile(canonicalTask, "utf8");
  const prior = priorImplementationFailure(before, round - 1);
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
    const physical = await existingPhysicalCandidate(path.resolve(path.dirname(canonicalTask), claim), `Changed Areas target ${claim}`, workspaceRoot);
    const digest = physical === null ? "REMOVED"
      : `sha256:${createHash("sha256").update(await fs.readFile(physical)).digest("hex")}`;
    if (prior.testedState.get(claim) !== digest) corrections.push(claim);
  }
  const cumulative = [...new Set([...prior.correctionClaims, ...corrections])]
    .sort((left, right) => left.localeCompare(right, "en"));
  const existing = sectionBody(before, "Corrections Applied");
  if (existing !== "- none") {
    const declared = await canonicalizeScopeSection({
      workspaceRoot,
      taskArtifact: canonicalTask,
      taskText: before,
      approvedTargets,
      heading: "Corrections Applied",
    });
    if (JSON.stringify(declared.claims) !== JSON.stringify(cumulative)) {
      fail("Corrections Applied does not match mechanically derived correction paths");
    }
    return corrections;
  }
  if (prior.correctionClaims.length !== 0) fail("Corrections Applied omits historical correction paths");
  const correctionBody = cumulative.length === 0 ? "- none" : cumulative.map((claim) => `- \`${claim}\``).join("\n");
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
  return corrections;
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
  operation, parsed, workspace, taskArtifact, taskText, targets, removed, capturedEntries, testedScope, evidenceOwner,
}) {
  const scalar = (label, value) => serializeMarkdownScalar(label, value, EXPLANATORY_EXECUTION_FIELDS.has(label));
  const prefix = operation === "EXECUTE_SLICE" ? "implementation-check" : "findings-check";
  const selected=await assertOwnedOperationalCandidate({candidateExecutionRoot:path.dirname(path.dirname(taskArtifact)),slice:path.basename(taskArtifact,'.md'),resolveWorkspace:resolveExecutionWorkspace,readActivated:readExecutionActivation});
  const index=await readDeliveryContinuity(selected.workspace);
  const delivery=index.deliveries.find(d=>d.slice===selected.marker.slice);
  const logical=await readDeliveryHistory(selected.workspace,delivery,taskText);
  const checkId = nextExecutionCheckId(logical.text, prefix);
  const testedRecord = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets,
    removed,
    capturedEntries,
    evidenceOwner,
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

async function capturedExecutionEntries({ receiptFile, operation, workspace, taskArtifact, targets, removed }) {
  if (receiptFile === undefined) return null;
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  if (receipt.testedState === undefined || receipt.testedState === null) {
    if (Number.isSafeInteger(receipt.attempt)) fail("official runner receipt has no captured Tested state");
    return null;
  }
  const slice = path.basename(taskArtifact, ".md");
  const stem = `${String(receipt.sequence).padStart(3, "0")}-${operation.toLowerCase()}-${slice}-attempt-${receipt.attempt}`;
  if (receipt.transport !== "native" && (receipt.operation !== operation || receipt.slice !== slice
    || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1
    || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1
    || path.basename(receiptFile) !== `${stem}.receipt.json`
    || path.basename(receipt.eventsPath ?? "") !== `${stem}.events.jsonl`
    || path.basename(receipt.semanticResponseFile ?? "") !== `${stem}.response.json`)) {
    fail("captured Tested state attempt identity mismatch");
  }
  const workspaceRoot = await canonicalWorkspacePath(workspace);
  const candidateTask = await regularFile(taskArtifact, "taskArtifact");
  // Resolve the official source through the existing owned-copy boundary for
  // both layouts. Candidate depth and missing-marker fallback cannot select it.
  const { workspace: official } = await privateTaskAuthority(candidateTask);
  const sourceTaskPath = path.join(official.executionRoot, "tasks", `${slice}.md`);
  if (receipt.testedState.workspace !== workspaceRoot
    || receipt.testedState.sourceTaskPath !== sourceTaskPath) {
    fail("captured Tested state workspace/source mismatch");
  }
  const entries = receipt.testedState.entries;
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.path !== "string"
    || !/^(?:sha256:[0-9a-f]{64}|REMOVED)$/u.test(entry.value))) {
    fail("captured Tested state is malformed");
  }
  const claims = entries.map((entry) => normalizedRelative(entry.path, "captured Tested state path"));
  if (new Set(claims).size !== claims.length
    || claims.some((claim, index) => index > 0 && claim.localeCompare(claims[index - 1], "en") <= 0)) {
    fail("captured Tested state paths are not unique and ordered");
  }
  const selected = [...targets.map((target) => claimFor(candidateTask, target)), ...removed]
    .sort((a, b) => a.localeCompare(b, "en"));
  if (JSON.stringify(selected) !== JSON.stringify(claims)) {
    fail("captured Tested state does not match candidate target scope");
  }
  return entries;
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
  operation, response, workspace, taskArtifact, receiptFile, semanticResponseFile, verificationEventIds, resolveManagedFindingsCycle, automaticCheckRound,
}) {
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]).has(operation)) {
    fail("execution bundle operation must be EXECUTE_SLICE or APPLY_FINDINGS");
  }
  const capturedReceipt = await requireAcceptedRunnerResult({ operation, slice: path.basename(taskArtifact, '.md'), workspace, receiptFile, semanticResponseFile, response });
  if (automaticCheckRound !== undefined && receiptFile === undefined) fail("managed round ownership requires a captured receipt");
  const payload = parseCapturedResult(operation, (text, op) => parseSemanticExecutionPayload(text, op, { automaticCheckRound }), response);
  if (capturedReceipt.transport === 'native' && payload.automaticCheckRound !== `${capturedReceipt.attempt}/3`) fail('native semantic round differs from reserved invocation');
  const mechanicalCommands = receiptFile === undefined ? payload.commands
    : await resolveCapturedRunnerCommands({
      receiptFile, semanticResponseFile, operation, eventIds: verificationEventIds ?? null,
    }, payload.commands);
  if (mechanicalCommands.length === 0 && !new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(payload.status)) {
    fail("runner completed no marked verification command");
  }
  assertRunnerVerdictConsistency(operation, payload.status, mechanicalCommands);
  const correctionPaths = await populateExecutionCorrectionClaims({
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
  if (resolveManagedFindingsCycle !== undefined) {
    const managedFindingsCycle = await resolveManagedFindingsCycle(payload);
    if (operation !== "APPLY_FINDINGS" || receiptFile === undefined || !/^attempt-[0-9]{2,}$/.test(managedFindingsCycle)) {
      fail("managed Findings cycle requires a captured APPLY receipt and canonical attempt");
    }
    parsed["Findings cycle"] = managedFindingsCycle;
  }
  if (operation === "APPLY_FINDINGS" && resolveManagedFindingsCycle === undefined) {
    if (receiptFile !== undefined && capturedReceipt.transport !== "native") fail("managed APPLY requires sealed findings ownership");
    const attempts = sectionBody(await fs.readFile(taskArtifact, "utf8"), "Validation Attempts")
      .split(/(?=^### attempt-[0-9]{2,}$)/mu).filter(record => record.startsWith("### attempt-"));
    const current = attempts.at(-1);
    const cycle = current?.match(/^### (attempt-[0-9]{2,})$/mu)?.[1];
    if (cycle === undefined || current.match(/^- Status: (.+)$/mu)?.[1] !== "NEEDS_FIX") fail("native APPLY has no current NEEDS_FIX cycle");
    parsed["Findings cycle"] = cycle;
  }
  parsed.Commands = mechanicalCommands;
  const { targets, removed } = await deriveExecutionTargetsFromTask({ workspace, taskArtifact });
  const capturedEntries = await capturedExecutionEntries({ receiptFile, operation, workspace, taskArtifact, targets, removed });
  const taskText = await fs.readFile(taskArtifact, "utf8");
  if (operation === "APPLY_FINDINGS" && parsed["Automatic check round"] !== "1/3") {
    const previous = sectionBody(taskText, "Findings Test Evidence")
      .split(/(?=^### findings-check-[0-9]{2,}$)/mu).filter((record) => record.trim() !== "").at(-1);
    const priorRound = Number(parsed["Automatic check round"].slice(0, 1)) - 1;
    if (previous === undefined || !previous.includes(`- Automatic check round: ${priorRound}/3`)
      || !previous.includes("- Status: TESTS_FAIL")) {
      fail("APPLY_FINDINGS correction requires prior TESTS_FAIL findings check");
    }
    parsed["Prior-round failure"] = previous.match(/^- Failures: (.+)$/mu)?.[1];
    parsed["Correction applied"] = payload.correctionsCovered;
    parsed["In-slice rationale"] = payload.selectionRationale;
    for (const name of ["Prior-round failure", "Correction applied", "In-slice rationale"]) {
      if (typeof parsed[name] !== "string" || /^(?:none|pending|n\/a)$/iu.test(parsed[name])) {
        fail(`APPLY_FINDINGS ${name} is required after round 1/3`);
      }
    }
  }
  parsed.correctionPaths = (correctionPaths ?? parseCanonicalPathSection(taskText, "Corrections Applied")).join(", ") || "none";
  const filelessReason = parsed.filelessReason ?? null;
  // Only the response/scope incompatibility is recoverable. All receipt,
  // filesystem, captured-state and authority checks above remain mechanical.
  const scopeMismatch = targets.length + removed.length === 0 && (filelessReason === null || filelessReason.trim() === "")
    ? "fileless semantic execution response must include Fileless reason"
    : targets.length + removed.length !== 0 && filelessReason !== null
      ? "file-backed semantic execution response cannot include Fileless reason" : null;
  if (scopeMismatch !== null) {
    throw new RunnerSemanticResultError(operation,
      Object.assign(new Error(scopeMismatch), { code: "RUNNER_EXECUTION_SCOPE_INVALID" }));
  }
  const testedScope = targets.length + removed.length === 0
    ? serializeMarkdownScalar("filelessReason", filelessReason, true)
    : capturedEntries === null
      ? await canonicalTestedScope({ workspace, taskArtifact, targets, removed })
      : capturedEntries.map((entry) => entry.path).join(", ");
  return serializeCanonicalExecutionCheck({
    operation,
    parsed,
    workspace,
    taskArtifact,
    targets,
    removed,
    capturedEntries,
    taskText,
    testedScope,
    evidenceOwner: capturedReceipt.owner,
  });
}

export async function insertExecutionEvidenceInCandidate({ taskArtifact, operation, bundle, validateProspectiveTask }) {
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS"]).has(operation)
    || typeof bundle !== "string" || !/^### (?:implementation|findings)-check-[0-9]{2,}\n/u.test(bundle)) {
    fail("candidate insertion requires one canonical execution check");
  }
  const canonicalTask = await regularFile(taskArtifact, "candidate taskArtifact");
  await assertPrivateTask(canonicalTask);
  const executionRoot = path.dirname(path.dirname(canonicalTask));
  const roots = [executionRoot, path.dirname(executionRoot)];
  let candidateRoot = null;
  for (const root of roots) {
    if (!path.basename(root).startsWith(".stnl-execution-copy-")) continue;
    if (await fs.access(`${root}.copy.json`).then(() => true).catch(() => false)) {
      candidateRoot = root;
      break;
    }
  }
  if (candidateRoot === null) fail("evidence insertion requires an owned isolated execution candidate");
  const markerFile = `${candidateRoot}.copy.json`;
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
  let updated = `${taskText.slice(0, bodyStart)}${replacement}${taskText.slice(end + 1)}`;
  const blocker = sectionBody(updated, "Delegation Blocker");
  if (blocker !== "- none" && blocker.includes("- State: active")) {
    if (!blocker.includes(`- Operation: ${operation}\n`)) fail("active Delegation Blocker belongs to another operation");
    updated = replaceSectionBody(updated, "Delegation Blocker",
      `${blocker.replace("- State: active", "- State: resolved")}\n- Resolution: ${identifier.slice(4)} returned a valid runner result`);
  }
  if (validateProspectiveTask !== undefined) await validateProspectiveTask({ slice, text: updated });
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

export async function persistMalformedRunnerResultInCandidate({
  taskArtifact, operation, receiptFile, semanticResponseFile, diagnostic, error = null, workspace,
}) {
  if (!new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]).has(operation)) fail("invalid runner recovery operation");
  const expectedDiagnostic = recoverableRunnerResultDiagnostic(error);
  if (expectedDiagnostic === null || expectedDiagnostic !== diagnostic) {
    fail("malformed-output recovery requires the original deterministic producer rejection");
  }
  const task = await regularFile(taskArtifact, "candidate taskArtifact");
  await assertPrivateTask(task);
  if (receiptFile === undefined && operation === "VALIDATE_SLICE") {
    fail("native malformed-output recovery is limited to candidate execution checks");
  }
  if (typeof semanticResponseFile !== "string" || !path.isAbsolute(semanticResponseFile)) {
    fail("malformed-output recovery requires an absolute semantic response path");
  }
  const receiptPath = receiptFile === undefined ? null : await regularFile(receiptFile, "runner receipt");
  const responsePath = await regularFile(semanticResponseFile, "semantic response");
  const context = receiptPath === null ? null : await assertManagedRunnerReceipt({
    operation, slice: path.basename(task, ".md"), workspace,
    receiptFile, semanticResponseFile, allowRejected: true,
  });
  const receipt = receiptPath === null ? null : JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const responseHash = createHash("sha256").update(await fs.readFile(responsePath)).digest("hex");
  const rejected = context !== null && receipt?.status === "RUNNER_RESULT_BLOCKED";
  if (receipt !== null && ((!rejected && receipt.status !== "RUNNER_RESPONSE_CAPTURED") || receipt.operation !== operation
    || receipt.semanticResponseFile !== responsePath || receipt.semanticResponseSha256 !== responseHash
    || (!rejected && receipt.captureFailure !== null) || receipt.error != null)) {
    fail("malformed-output recovery requires a matching captured runner response and receipt");
  }
  const executionRoot = path.dirname(path.dirname(task));
  const candidateRoot = path.basename(executionRoot).startsWith(".stnl-execution-copy-")
    ? executionRoot : path.dirname(executionRoot);
  if (!path.basename(candidateRoot).startsWith(".stnl-execution-copy-")
    || !await fs.access(`${candidateRoot}.copy.json`).then(() => true).catch(() => false)) {
    // VALIDATE_SLICE uses its separately verified candidate boundary.
    if (operation !== "VALIDATE_SLICE") fail("malformed-output recovery requires an owned execution candidate");
  }
  const slice = path.basename(task, ".md");
  if (operation !== "VALIDATE_SLICE") {
    const markerFile = await regularFile(`${candidateRoot}.copy.json`, "candidate marker");
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
    const expectedTask = path.join(candidateRoot, executionRoot === candidateRoot ? "" : "execution", "tasks", `${slice}.md`);
    const allowedParents = typeof marker.specPath === "string"
      ? [path.dirname(marker.specPath), ...(path.basename(marker.specPath) === "feature_spec.md"
        ? [path.dirname(path.dirname(marker.specPath))] : [])]
      : [];
    if (!/^slice-[0-9]{2,}$/u.test(slice) || marker.slice !== slice || task !== expectedTask
      || typeof marker.specPath !== "string" || !path.isAbsolute(marker.specPath)
      || !allowedParents.includes(path.dirname(candidateRoot))
      || typeof marker.executionRoot !== "string" || !path.isAbsolute(marker.executionRoot)
      || inside(candidateRoot, marker.executionRoot)) {
      fail("malformed-output recovery candidate identity mismatch");
    }
  } else if (!/^slice-[0-9]{2,}$/u.test(slice)) {
    fail("malformed-output recovery requires a canonical slice task");
  }
  let taskText = await fs.readFile(task, "utf8");
  if ((rejected || error instanceof RunnerSemanticResultError && error.cause?.code === "RUNNER_EXECUTION_SCOPE_INVALID")
    && operation !== "VALIDATE_SLICE"
    && sectionBody(taskText, "Changed Areas") === "- none") {
    // An unproved fileless claim cannot be published as Changed Areas: none.
    // Restore only the pre-run scope/checklist, and only with unchanged live
    // identity and no newly persisted evidence. Never fill the missing reason
    // or discard an earlier private check; strict validation still owns it.
    const markerPath = await regularFile(`${candidateRoot}.copy.json`, "candidate marker");
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (marker.slice !== slice || typeof marker.executionRoot !== "string" || !path.isAbsolute(marker.executionRoot)) {
      fail("malformed-output scope recovery candidate identity mismatch");
    }
    const livePath = await regularFile(path.join(marker.executionRoot, "tasks", `${slice}.md`), "live taskArtifact");
    const liveBytes = await fs.readFile(livePath);
    const source = marker.source?.find((entry) => entry.path === `tasks/${slice}.md`);
    if (source?.hash !== createHash("sha256").update(liveBytes).digest("hex")) {
      fail("live task changed since candidate preparation");
    }
    const liveText = liveBytes.toString("utf8");
    if (["Implementation Test Evidence", "Findings Test Evidence", "Validation Attempts", "Effective Validation Base"]
      .every((heading) => sectionBody(taskText, heading) === sectionBody(liveText, heading))) {
      taskText = replaceSectionBody(taskText, "Changed Areas", sectionBody(liveText, "Changed Areas"));
      taskText = replaceSectionBody(taskText, "Checklist", sectionBody(liveText, "Checklist"));
    }
  }
  const section = sectionBody(taskText, "Delegation Blocker");
  if (section !== "- none" && !section.includes(`- Operation: ${operation}\n`)) {
    fail("existing Delegation Blocker belongs to another operation");
  }
  const recordSection = operation === "EXECUTE_SLICE" ? "Implementation Test Evidence"
    : operation === "APPLY_FINDINGS" ? "Findings Test Evidence" : "Validation Attempts";
  const prefix = operation === "EXECUTE_SLICE" ? "implementation-check"
    : operation === "APPLY_FINDINGS" ? "findings-check" : "attempt";
  const ids = [...sectionBody(taskText, recordSection).matchAll(new RegExp(`^### (${prefix}-[0-9]{2,})$`, "gmu"))];
  const afterRecord = ids.at(-1)?.[1] ?? "none";
  const cause = JSON.stringify(String(diagnostic)).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  const blocker = [
    `- Operation: ${operation}`,
    "- Kind: malformed-output",
    "- State: active",
    `- After record: ${afterRecord}`,
    "- Causes:",
    `  - Producer rejected ${receipt === null ? "native runner-reported" : rejected ? "diagnostic" : "captured"} response sha256:${responseHash}: ${cause}`,
    `  - ${receipt === null ? "Native response" : rejected ? "Rejected diagnostic" : "Captured response"}: ${responsePath}${receiptPath === null ? "; no managed receipt" : `; receipt: ${receiptPath}`}`,
    `- Required action: Resume ${operation} ${slice} with a valid captured runner response.`,
  ].join("\n");
  taskText = replaceSectionBody(taskText, "Delegation Blocker", blocker);
  const temporary = `${task}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, taskText, { flag: "wx" });
    await fs.rename(temporary, task);
  } finally { await fs.rm(temporary, { force: true }); }
  return { state: "RUNNER_RESULT_BLOCKED", operation, slice, responseHash, diagnostic: String(diagnostic) };
}

export async function prepareRunnerValidationPersistenceFromResponse({
  operation = "VALIDATE_SLICE", response, workspace, taskArtifact, specPath, slice, validationType,
  receiptFile, semanticResponseFile, verificationEventIds,
}) {
  if (operation !== "VALIDATE_SLICE") fail("semantic validation producer operation must be VALIDATE_SLICE");
  const capturedReceipt = await requireAcceptedRunnerResult({ operation, slice, workspace, receiptFile, semanticResponseFile, response });
  const parsed = parseCapturedResult(operation, parseSemanticValidationPayload, response);
  const mechanicalCommands = receiptFile === undefined ? parsed.commands
    : await resolveCapturedRunnerCommands({
      receiptFile, semanticResponseFile, operation, eventIds: verificationEventIds ?? null,
    }, parsed.commands);
  if (mechanicalCommands.length === 0 && parsed.status !== "BLOCKED") {
    fail("runner completed no marked verification command");
  }
  assertRunnerVerdictConsistency(operation, parsed.status, mechanicalCommands);
  const state = await inspectExecutionState(specPath);
  const selected = state.tasks?.get(canonicalSliceLabel(String(slice)));
  if (selected === undefined) fail("validation producer could not resolve the selected task");
  const derivedType = validationType ?? (selected.attempts.length === 0 ? "initial" : "revalidation");
  if (!new Set(["initial", "revalidation"]).has(derivedType)) {
    fail("validation producer Type must be initial or revalidation");
  }
  // VALIDATE has no semantic filelessReason field. Reuse only the current
  // validated live evidence owner, never a candidate claim or runner prose.
  let authoritativeFilelessReason = null;
  if (selected.sections.get("Changed Areas") === "- none") {
    if (await regularFile(taskArtifact, "taskArtifact") !== await deriveTaskArtifact({ specPath, slice: String(slice) })) {
      fail("fileless validation task must match the selected live authority");
    }
    const owner = selected.base.present && selected.base.fileless
      ? selected.sections.get("Effective Validation Base")
      : selected.currentAuxiliaryCheck?.testedState.length === 0 ? selected.currentAuxiliaryCheck.body : null;
    const reasons = [...String(owner ?? "").matchAll(/^- Fileless reason: (.+)$/gmu)];
    if (reasons.length !== 1) fail("fileless validation requires one reason from current validated execution evidence");
    authoritativeFilelessReason = decodeMarkdownScalar("Fileless reason", reasons[0][1], true);
  }
  const { targets, removed, inherited } = await deriveValidationTargetsFromTask({
    workspace, taskArtifact, filelessReason: authoritativeFilelessReason,
    state: parsed.status === "PASS" ? state : null, selectedSlice: canonicalSliceLabel(String(slice)),
  });
  const filelessReason = targets.length + removed.length === 0 ? authoritativeFilelessReason : null;
  const verifiedScope = targets.length + removed.length === 0 ? "fileless task state"
    : await canonicalTestedScope({ workspace, taskArtifact, targets, removed });
  const commands = await canonicalValidationCommands({
    commands: mechanicalCommands,
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
    serializeRunnerResponse({ operation, values, workspace, taskArtifact, targets, removed, commands, filelessReason }),
    serializeRunnerRecord({ workspace, taskArtifact, targets, removed, commands, filelessReason, evidenceOwner: capturedReceipt.owner }),
    serializeRunnerManifest({ workspace, taskArtifact, targets, removed, commands, filelessReason }),
  ]);
  if (inherited.size !== 0) {
    const recordLines = new Set(testedRecord.split("\n"));
    const manifestLines = new Set(formalManifest.split("\n"));
    const workspaceRoot = await canonicalWorkspacePath(workspace);
    for (const [claim, { expected, target }] of inherited) {
      const entry = `  - \`${claim}\` | ${expected}`;
      if (!recordLines.has(entry) || !manifestLines.has(entry)) {
        fail(`superseded path capture differs from tested file evidence: ${claim}`);
      }
      if (await regularFile(target, `superseded path ${claim}`, workspaceRoot) !== target
        || `sha256:${createHash("sha256").update(await fs.readFile(target)).digest("hex")}` !== expected) {
        fail(`superseded path drifted after validation capture: ${claim}`);
      }
    }
  }
  const bundle = `- Runner response:\n${responseBlock}\n- Tested record:\n${testedRecord}\n- Formal manifest:\n${formalManifest}`;
  const attemptNumber = selected.attempts.length + 1;
  const attemptId = `attempt-${String(attemptNumber).padStart(2, "0")}`;
  const serializedCommands = serializeCommands(commands);
  const attemptRecord = [
    `### ${attemptId}`,
    "",
    await evidenceBinding(taskArtifact, capturedReceipt.owner),
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
    } else if (name === "--receipt-file") {
      if (values.receiptFile !== undefined) fail("duplicate --receipt-file");
      if (!path.isAbsolute(value)) fail("--receipt-file must be absolute");
      values.receiptFile = value;
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
  if (values.receiptFile !== undefined && !(values.executionBundle && values.insertCandidate)
    && !(values.validationBundle && values.semanticResponseFile !== undefined)) {
    fail("--receipt-file requires candidate execution or semantic validation bundle");
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
      try {
        const bundle = await serializeRunnerExecutionBundleFromResponse({
          operation: values.operation,
          response: await fs.readFile(values.semanticResponseFile, "utf8"),
          workspace: values.workspace,
          taskArtifact: values.taskArtifact,
          receiptFile: values.receiptFile,
          semanticResponseFile: values.semanticResponseFile,
        });
        if (values.insertCandidate) {
          const identifier = await insertExecutionEvidenceInCandidate({
            taskArtifact: values.taskArtifact, operation: values.operation, bundle,
          });
          process.stdout.write(`${identifier} inserted into isolated candidate\n`);
        } else process.stdout.write(`${bundle}\n`);
      } catch (error) {
        const diagnostic = recoverableRunnerResultDiagnostic(error);
        if (!values.insertCandidate || diagnostic === null) throw error;
        const recovery = await persistMalformedRunnerResultInCandidate({
          taskArtifact: values.taskArtifact, operation: values.operation,
          receiptFile: values.receiptFile, semanticResponseFile: values.semanticResponseFile,
          diagnostic, error, workspace: values.workspace,
        });
        process.stdout.write(`${JSON.stringify(recovery)}\n`);
      }
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
          receiptFile: values.receiptFile,
          semanticResponseFile: values.semanticResponseFile,
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
