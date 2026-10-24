#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertSnapshotIntegrity, createSnapshot } from './benchmark-snapshot.mjs';
import { createReporter } from './benchmark-ui.mjs';
import { budgetViolation, artifactMetrics } from './benchmark.mjs';
import { contextPolicy, preparationHandoff, assertNativeCaptures,
  retainBeforeClose, finishCloseEvidence, validateNativeLedger } from './native-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MARKER = 'sentinel-todo-run-v2\n';
const ACTIVE = path.join(RUNS, '.active-run.json');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'runtime', 'benchmark.mjs');
const MANIFEST = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'benchmark.json');
const PHASE = {
  SPEC_INIT: 'SPEC', SPEC_READINESS: 'REVIEW_VALIDATE', SPEC_RESUME: 'SPEC',
  SPEC_PROMOTE: 'SPEC', SPEC_CLOSE: 'SPEC',
  PLAN: 'PLAN', REPLAN: 'PLAN', REVIEW_PLAN: 'REVIEW_VALIDATE',
  EXECUTE_SLICE: 'EXECUTE', APPLY_FINDINGS: 'EXECUTE', VALIDATE_SLICE: 'REVIEW_VALIDATE',
};
const TEMPLATE = {
  SPEC_INIT: 'spec-init.md', SPEC_READINESS: 'spec-readiness.md',
  SPEC_RESUME: 'spec-resume.md', SPEC_PROMOTE: 'spec-resume.md', SPEC_CLOSE: 'spec-close.md',
  PLAN: 'execution-plan.md', REPLAN: 'execution-replan.md', REVIEW_PLAN: 'execution-plan-review.md',
  EXECUTE_SLICE: 'slice-execute-codex.md', APPLY_FINDINGS: 'slice-apply-findings-codex.md',
  VALIDATE_SLICE: 'slice-validate-codex.md',
};
const RUNNER_OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
const BLOCKED_STATES = new Set(['AUXILIARY_BLOCKED', 'DIVERGENCE_BLOCKED', 'REPLAN_REQUIRED',
  'REQUIREMENTS_CHANGED', 'RUNNER_INITIALIZATION_BLOCKED', 'RUNNER_RESULT_BLOCKED', 'VALIDATION_BLOCKED']);
const PROVIDER_CONFIGURATION_ERRORS = new Set(['invalid_json_schema', 'invalid_configuration']);

export function providerConfigurationError(events, receiptError = null) {
  const candidates = [receiptError, ...events].filter(Boolean)
    .flatMap((item) => [item, item.error].filter(Boolean));
  const event = candidates.find((item) => PROVIDER_CONFIGURATION_ERRORS.has(item.code)
    || PROVIDER_CONFIGURATION_ERRORS.has(String(item.message ?? '').match(/\b(?:invalid_json_schema|invalid_configuration)\b/u)?.[0]));
  if (!event) return null;
  const code = PROVIDER_CONFIGURATION_ERRORS.has(event.code) ? event.code
    : String(event.message).match(/\b(?:invalid_json_schema|invalid_configuration)\b/u)[0];
  return { code, message: String(event.message ?? event.error ?? code) };
}

export function guardOperationProvenance(outcome, operation, collaborationEvents, capturedReceipts) {
  if (collaborationEvents.length > 0) return { result: 'BLOCKED', blocker: 'UNMANAGED_COLLABORATION' };
  if (RUNNER_OPERATIONS.has(operation) && ['PASS', 'NEEDS_FIX'].includes(outcome.result) && capturedReceipts < 1) {
    return { result: 'BLOCKED', blocker: 'OFFICIAL_RUNNER_RECEIPT_MISSING' };
  }
  return outcome;
}

export async function unmanagedCollaborationEvents(eventsPath, operationId, runnerEventPaths = []) {
  return (await Promise.all([eventsPath, ...runnerEventPaths].map(async (file) =>
    (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => (file !== eventsPath || event.operationId === operationId)
        && event.type === 'item.completed' && event.item?.type === 'collab_tool_call')
      .map((event) => ({ source: file === eventsPath ? 'main' : 'runner',
        tool: event.item.tool ?? 'unknown', itemId: event.item.id ?? null,
        receiverThreadIds: event.item.receiver_thread_ids ?? [] }))))).flat();
}

function fail(message) { throw new Error(message); }
function hash(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function caseName(id) { return `case-${id.toLowerCase()}`; }
let reporter = createReporter({ format: 'human', isTTY: process.stdout.isTTY,
  width: process.stdout.columns ?? 100, noColor: Object.hasOwn(process.env, 'NO_COLOR') });
function announce(value) { reporter.emit(value); }
function command(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [BENCHMARK, ...args], { cwd, encoding: 'utf8', timeout: 300_000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}
async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
function ledgerPath(runRoot) { return path.join(runRoot, '.turn-ledger.json'); }
export async function initializeTurnBudget(runRoot, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('turn budget limit must be a positive integer');
  await atomicJson(ledgerPath(runRoot), { version: 1, limit, total: 0,
    nextNumber: 0, reservations: [], turns: [] });
}
export async function budgetSnapshot(runRoot) {
  const ledger = await readJson(ledgerPath(runRoot)).catch(() => null);
  if (!ledger) return { turnBudget: { limit: null, consumed: null, remaining: null, mainTurns: null, runnerTurns: null } };
  const dispatched = ledger.turns.filter((turn) => turn.state !== 'not_dispatched');
  return { turnBudget: { limit: ledger.limit, consumed: ledger.total,
    remaining: ledger.limit - ledger.total - (ledger.reservations?.length ?? 0),
    mainTurns: dispatched.filter((turn) => turn.role === 'main').length,
    runnerTurns: dispatched.filter((turn) => turn.role === 'runner').length } };
}
async function exists(file) { return fs.lstat(file).then(() => true).catch(() => false); }
async function assertRun(id) {
  if (!/^[a-z0-9][a-z0-9-]{7,}$/u.test(id)) fail('invalid run ID');
  const root = path.join(RUNS, id);
  if (await fs.realpath(root) !== root || path.dirname(root) !== await fs.realpath(RUNS)
    || (await fs.lstat(root)).isSymbolicLink()
    || await fs.readFile(path.join(root, '.sentinel-benchmark-owned'), 'utf8') !== MARKER) {
    fail('run is not an owned canonical benchmark directory');
  }
  return root;
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function assertInactive(id) {
  if (!await exists(ACTIVE)) return;
  const active = await readJson(ACTIVE);
  if (processAlive(active.pid)) fail(`benchmark ${active.runId} is active`);
  if (active.runId === id) fail('run has an unclean interruption; inspect it before cleaning');
}
async function acquire(id) {
  await fs.mkdir(RUNS, { recursive: true });
  if (await exists(ACTIVE)) {
    const active = await readJson(ACTIVE);
    if (processAlive(active.pid)) fail(`benchmark ${active.runId} is already active`);
    fail(`interrupted benchmark ${active.runId} needs inspection before another run`);
  }
  await fs.writeFile(ACTIVE, `${JSON.stringify({ runId: id, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
}
async function release(id) {
  const active = await readJson(ACTIVE).catch(() => null);
  if (active?.runId === id && active.pid === process.pid) await fs.unlink(ACTIVE);
}
let ledgerWrite = Promise.resolve();
function budgetPause() {
  const error = new Error('per-run turn budget exhausted; operation paused before dispatch');
  error.code = 'PAUSED_BUDGET_OR_QUOTA';
  return error;
}
async function updateLedger(runRoot, mutator, limit) {
  const job = ledgerWrite.then(async () => {
    let ledger;
    const file = ledgerPath(runRoot);
    if (await exists(file)) ledger = await readJson(file);
    else fail('run turn budget ledger is missing; refusing to reset consumed turns');
    if (!Array.isArray(ledger.reservations)) ledger.reservations = [];
    ledger.nextNumber ??= Math.max(ledger.total, ...ledger.turns.map((turn) => turn.number));
    const value = mutator(ledger);
    await atomicJson(file, ledger);
    return value;
  });
  ledgerWrite = job.catch(() => {});
  return job;
}
function availableTurns(ledger) { return ledger.limit - ledger.total - ledger.reservations.length; }
export async function admitOperation({ runRoot, runId, caseId, operation, runnerRequired, runnerSlots = runnerRequired ? 1 : 0, limit }) {
  return updateLedger(runRoot, (ledger) => {
    if (!Number.isSafeInteger(runnerSlots) || runnerSlots < 0 || runnerSlots > 3) fail('invalid native child margin');
    if (availableTurns(ledger) < 1 + runnerSlots) throw budgetPause();
    const main = randomUUID();
    const runners = Array.from({ length: runnerSlots }, () => randomUUID());
    ledger.reservations.push({ id: main, runId, caseId, role: 'main', operation,
      reservedAt: new Date().toISOString() });
    for (const runner of runners) ledger.reservations.push({ id: runner, runId, caseId,
      role: 'runner', operation, reservedAt: new Date().toISOString() });
    return { main, runner: runners[0] ?? null, runners };
  }, limit);
}
export async function reserveExtraRunner({ runRoot, runId, caseId, operation, limit }) {
  return updateLedger(runRoot, (ledger) => {
    if (availableTurns(ledger) < 1) throw budgetPause();
    const id = randomUUID();
    ledger.reservations.push({ id, runId, caseId, role: 'runner', operation,
      reservedAt: new Date().toISOString() });
    return id;
  }, limit);
}
export async function startReservedTurn(runRoot, id, limit) {
  return updateLedger(runRoot, (ledger) => {
    const index = ledger.reservations.findIndex((reservation) => reservation.id === id);
    if (index < 0) fail('turn reservation is missing');
    const [reservation] = ledger.reservations.splice(index, 1);
    const number = ++ledger.nextNumber;
    ledger.total += 1;
    ledger.turns.push({ number, runId: reservation.runId, caseId: reservation.caseId,
      role: reservation.role, operation: reservation.operation, startedAt: new Date().toISOString(),
      state: 'dispatched' });
    return number;
  }, limit);
}
export async function settleTurn(runRoot, number, turn, limit) {
  return updateLedger(runRoot, (ledger) => {
    const entry = ledger.turns.find((item) => item.number === number);
    if (!entry || !['dispatched', 'uncertain', 'completed'].includes(entry.state)) fail('turn ledger settlement is invalid');
    if (entry.state === 'completed') {
      if (turn?.completed === true && entry.threadId === turn.threadId) return;
      fail('completed ledger turn cannot be changed');
    }
    entry.endedAt = new Date().toISOString();
    entry.threadId = turn?.threadId ?? null;
    if (turn?.turnStarted === false && turn?.threadId == null) {
      entry.state = 'not_dispatched';
      ledger.total -= 1;
    } else entry.state = turn?.completed ? 'completed' : turn?.turnStarted == null ? 'uncertain' : 'failed';
  }, limit);
}
async function recordUnadmittedChild(runRoot, { caseId, operation, binding }) {
  return updateLedger(runRoot, ledger => {
    if (ledger.turns.some(turn => turn.caseId === caseId && turn.operation === operation
      && turn.threadId === binding.agentThreadId)) return false;
    ledger.total++;
    ledger.turns.push({ number: ++ledger.nextNumber, caseId, operation, role: 'runner',
      runId: path.basename(runRoot), state: 'uncertain', threadId: binding.agentThreadId, agentPath: binding.agentPath,
      unadmitted: true, startedAt: new Date().toISOString() });
    return true;
  });
}
export async function releaseReservation(runRoot, id, limit) {
  if (id === null) return;
  return updateLedger(runRoot, (ledger) => {
    const index = ledger.reservations.findIndex((reservation) => reservation.id === id);
    if (index >= 0) ledger.reservations.splice(index, 1);
  }, limit);
}

export function renderLauncher(template, values) {
  const found = [...template.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]);
  if (new Set(found).size !== found.length) fail('launcher has duplicate parameter placeholders');
  for (const name of found) {
    const value = values[name];
    const semantic = new Set(['NEW_INFORMATION', 'CONTEXT', 'REPLAN_REASON']).has(name);
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')
      || (!semantic && /[\r\n]/u.test(value))) fail(`launcher parameter ${name} is missing or malformed`);
  }
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/gu, (_whole, name) => values[name]);
  if (/\{\{[^}]+\}\}|__[^_\s]+__/u.test(rendered)) fail('launcher contains an unresolved placeholder');
  return rendered;
}

// Normal operator context, not a product command or hidden binding. A file
// contract does not configure a generic child's model/effort by itself.
export function nativeRunnerContext(operation, bundle, eventsFile) {
  if (!RUNNER_OPERATIONS.has(operation)) return '';
  const runner = bundle?.runner;
  if (!runner || !path.isAbsolute(runner.path) || !/^sha256:[0-9a-f]{64}$/u.test(runner.sha256)
    || runner.model !== 'gpt-6-luna' || runner.effort !== 'medium') fail('missing explicit generic runner profile');
  if (!path.isAbsolute(eventsFile ?? '') || path.resolve(eventsFile) !== eventsFile) fail('missing official capture event path');
  return `\nIndependent checks use a fresh generic native agent (fork_turns=none), not a registered runner type. Select model=${runner.model} and reasoning_effort=${runner.effort} explicitly when spawning; if unavailable, block before spawn.\n`
    + `Load the complete contract at ${runner.path} (SHA-256 ${runner.sha256}) before scope actions. Use an ordinary full-file cat read with sufficient output to avoid truncation; preserve the complete official command output. Reading the file supplies task instructions, not a registered agent role.\n`
    + `Transport captures the complete public child response without interpreting it. After the child completes, wait within the existing operation deadline for its complete native.child.completed record in ${eventsFile}; match binding.agentPath to that child and pass toolResultFile unchanged to the official capture-native command. Do not author an envelope or copy/strip mailbox text. A missing record is not permission to synthesize evidence or start another turn. Bind before verification and perform capture/publication yourself through the existing controller.\n`
    + (['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(operation)
      ? 'The selected operation includes the approved implementation/corrections and preparation of reusable tests. The controller nextAction names its next command; it does not replace that work. Complete the approved work and test preparation before delegating read-only verification. The child must not implement.\n' : 'The independent child judges the complete canonical criteria; tests alone are not the authority. For the explicitly requested integral judgment reserve-dispatch --terminal before spawn. A concluded formal refusal may use only the single successor admitted by the public normalization after publication/readback/cleanup; preserve the first refusal. NEEDS_FIX follows its separate findings handoff; BLOCKED or uncertainty grants no successor.\n');
}

export function assertNativeLauncher(prompt, context, numericSlice) {
  const declarations = [...prompt.matchAll(/^([A-Z_]+)=(.*)$/gmu)];
  const expected = { SPEC_PATH: context.specPath, OPERATION: context.operation, SLICE: numericSlice };
  for (const [name, value] of Object.entries(expected)) {
    const matches = declarations.filter((match) => match[1] === name);
    if (matches.length !== 1 || matches[0][2] !== value) fail(`native launcher ${name} disagrees with official context`);
  }
}

function dispatch(configuration, caseId, operation) {
  const phase = PHASE[operation];
  const target = configuration.productionProfile.cases[caseId][phase];
  if (!target) fail(`missing production-v3 dispatch for ${caseId}/${operation}`);
  return { phase, label: target.model, model: target.model.toLowerCase(), effort: target.effort };
}
function compactExecution(execution) {
  if (!execution) return null;
  if (execution.error) return { error: execution.error };
  return { state: execution.state, currentFingerprint: execution.currentFingerprint ?? null,
    legalOperations: execution.legalOperations ?? [], normalHandoff: execution.normalHandoff ?? null,
    recoveryTargets: execution.recoveryTargets ?? [],
    requiredRecoveryHandoff: execution.requiredRecoveryHandoff ?? null,
    mandatoryRecovery: execution.mandatoryRecovery ?? null,
    rows: execution.rows?.map((row) => ({ slice: row.slice, done: row.done, result: row.result })) ?? [] };
}
async function officialReadback(product, specPath) {
  if (!await exists(specPath)) return { lifecycle: { error: 'SPEC not created' }, execution: { error: 'SPEC not created' }, executionRaw: null };
  const lifecycle = await Promise.resolve().then(() => product.validateWorkspace(specPath)).catch((error) => ({ error: error.message }));
  const executionRaw = await product.inspectExecutionState(specPath).catch((error) => ({ error: error.message }));
  return { lifecycle: lifecycle.error ? lifecycle : { status: lifecycle.status, closed: lifecycle.closed },
    execution: compactExecution(executionRaw), executionRaw };
}
export function decideOutcome(operation, readback, completed, readinessResult = null) {
  const lifecycle = readback.lifecycle;
  const execution = readback.execution;
  if (!completed) return { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' };
  if (operation === 'SPEC_INIT') {
    return ['ready', 'draft', 'blocked'].includes(lifecycle?.status) && ['EMPTY', 'NO_EXECUTION'].includes(execution?.state)
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_INIT_INVALID' };
  }
  if (operation === 'SPEC_READINESS') {
    if (readinessResult === null || !['EMPTY', 'NO_EXECUTION'].includes(execution?.state)) return { result: 'BLOCKED', blocker: 'READINESS_RESULT_INVALID' };
    if (readinessResult.verdict === 'READY') return { result: 'PASS', blocker: null };
    if (readinessResult.findings.some((finding) => finding.action === 'DECISION_REQUIRED')) {
      return { result: 'BLOCKED', blocker: 'BLOCKED_REQUIRED_DECISION' };
    }
    return { result: 'NEEDS_FIX', blocker: null };
  }
  if (operation === 'SPEC_RESUME') {
    return ['ready', 'draft', 'blocked'].includes(lifecycle?.status) && ['EMPTY', 'NO_EXECUTION'].includes(execution?.state)
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_RESUME_INVALID' };
  }
  if (operation === 'SPEC_PROMOTE') {
    return lifecycle?.status === 'ready' && ['EMPTY', 'NO_EXECUTION'].includes(execution?.state)
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_PROMOTION_INVALID' };
  }
  if (operation === 'SPEC_CLOSE') {
    return lifecycle?.status === 'closed' && lifecycle?.closed === true
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_CLOSE_BLOCKED' };
  }
  if (execution?.error || BLOCKED_STATES.has(execution?.state)) {
    return { result: 'BLOCKED', blocker: execution?.error ? 'OFFICIAL_READBACK_ERROR' : `OFFICIAL_${execution.state}` };
  }
  if (['PLAN', 'REPLAN'].includes(operation) && readback.preparation?.status === 'AWAITING_REVIEW') return { result: 'PASS', blocker: null };
  if (operation === 'VALIDATE_SLICE' && execution?.state === 'VALIDATION_NEEDS_FIX') return { result: 'NEEDS_FIX', blocker: null };
  const accepted = {
    PLAN: ['PLANNED_DRAFT'], REVIEW_PLAN: ['MATERIALIZED_PRISTINE', 'EXECUTION_STARTED', 'IMPLEMENTED_AWAITING_VALIDATION', 'FINDINGS_CORRECTED'],
    EXECUTE_SLICE: ['IMPLEMENTED_AWAITING_VALIDATION'], APPLY_FINDINGS: ['FINDINGS_CORRECTED'],
    VALIDATE_SLICE: ['EXECUTION_STARTED', 'COMPLETE'], REPLAN: ['PLANNED_DRAFT', 'PENDING_REPLAN_DRAFT'],
  };
  if (accepted[operation]?.includes(execution?.state)) return { result: 'PASS', blocker: null };
  if (['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(operation)
    && execution?.requiredRecoveryHandoff?.operation === 'VALIDATE_SLICE') return { result: 'PASS', blocker: null };
  return { result: 'BLOCKED', blocker: 'OFFICIAL_TRANSITION_NOT_OBSERVED' };
}
export function nextHandoff(operation, readback, readinessResult = null) {
  if (operation === 'SPEC_CLOSE') return null;
  if (readback.executionRaw?.state === 'COMPLETE') return { operation: 'SPEC_CLOSE', slice: null };
  if (operation === 'SPEC_INIT') return { operation: readback.lifecycle?.status === 'ready' ? 'PLAN' : 'SPEC_READINESS', slice: null };
  if (operation === 'SPEC_READINESS') {
    if (readinessResult?.verdict === 'FINDINGS') return { operation: 'SPEC_RESUME', slice: null };
    return { operation: readback.lifecycle?.status === 'ready' ? 'PLAN' : 'SPEC_PROMOTE', slice: null };
  }
  if (operation === 'SPEC_RESUME') return { operation: 'SPEC_READINESS', slice: null };
  if (operation === 'SPEC_PROMOTE') return { operation: 'PLAN', slice: null };
  if (['PLAN', 'REPLAN'].includes(operation) && readback.preparation?.status === 'AWAITING_REVIEW') return { operation: 'REVIEW_PLAN', slice: null };
  const handoff = readback.executionRaw?.mandatoryRecovery
    ?? readback.executionRaw?.requiredRecoveryHandoff
    ?? readback.executionRaw?.normalHandoff
    ?? (readback.executionRaw ? readback.product?.deriveNormalHandoff?.(readback.executionRaw, operation) : null);
  return handoff?.operation ? { operation: handoff.operation, slice: handoff.slice ?? null } : null;
}

export function recoverableRunnerHandoff({ operation, slice, outcome, readback, priorOperations, remainingTurns }) {
  if (outcome.result !== 'BLOCKED' || outcome.blocker !== 'OFFICIAL_RUNNER_RESULT_BLOCKED'
    || !RUNNER_OPERATIONS.has(operation) || remainingTurns < 2) return null;
  const execution = readback.executionRaw;
  const blocker = execution?.activeDelegationBlockers?.[0];
  const handoff = execution?.mandatoryRecovery;
  if (execution?.state !== 'RUNNER_RESULT_BLOCKED' || blocker?.kind !== 'malformed-output'
    || blocker.operation !== operation || blocker.slice !== slice
    || handoff?.owner !== 'delegation-blocker' || handoff.operation !== operation
    || handoff.slice !== slice || handoff.sameOperationResumeRequired !== true
    || !execution.legalOperations?.some((target) => target.operation === operation && target.slice === slice)
    || priorOperations.some((entry) => entry.recovery?.operation === operation && entry.recovery.slice === slice)) return null;
  return { operation, slice, authority: execution.currentFingerprint, state: execution.state };
}

export function recoverableOfficialHandoff(input) {
  const { outcome, readback, priorOperations, remainingTurns, budgets, transportFailed = false } = input;
  const execution = readback.executionRaw;
  if (outcome.result !== 'BLOCKED' || transportFailed || execution?.error || readback.lifecycle?.error
    || !BLOCKED_STATES.has(execution?.state) || outcome.blocker !== `OFFICIAL_${execution.state}`
    || typeof execution.currentFingerprint !== 'string' || execution.currentFingerprint.trim() === ''
    || execution.recoveryTargets?.length !== 1 || !Number.isSafeInteger(remainingTurns)) return null;
  const target = execution.recoveryTargets[0];
  const slice = target.slice ?? null;
  if (!Object.hasOwn(PHASE, target.operation) || target.operation.startsWith('SPEC_')
    || !execution.legalOperations?.some((legal) => legal.operation === target.operation && legal.slice === slice)
    || remainingTurns < (RUNNER_OPERATIONS.has(target.operation) ? 2 : 1)
    || budgetViolation([...priorOperations, { operation: target.operation, slice }], budgets) !== null) return null;
  for (const handoff of [execution.mandatoryRecovery, execution.requiredRecoveryHandoff]) {
    if (handoff && (handoff.operation !== target.operation || (handoff.slice ?? null) !== slice)) return null;
  }
  // Mandatory same-operation recovery remains limited to the existing malformed-output repair.
  // Auxiliary/environment and runner initialization failures require external correction.
  if (target.sameOperationResumeRequired && recoverableRunnerHandoff(input) === null) return null;
  return { operation: target.operation, slice, authority: execution.currentFingerprint,
    state: execution.state, target };
}

export async function prepareOfficialRecovery({ product, specPath, ...input }) {
  const recovery = recoverableOfficialHandoff(input);
  if (recovery === null) return null;
  const fresh = await officialReadback(product, specPath);
  if (JSON.stringify(recoverableOfficialHandoff({ ...input, readback: fresh })) !== JSON.stringify(recovery)) return null;
  const rejection = fresh.executionRaw?.activeDelegationBlockers?.[0]?.recoveryProof;
  const admission = recovery.state === 'RUNNER_RESULT_BLOCKED' && rejection ? {
    expectedActivationId: fresh.executionRaw.activation.activationId,
    rejectedOperationAttemptId: fresh.executionRaw.activation.activeAttempt?.operationAttemptId, rejection,
  } : null;
  const preflight = admission
    ? await product.preflightRunnerResultRecovery(specPath, recovery.operation, specInput(recovery.slice), admission)
    : await product.preflightExecutionOperation(specPath, recovery.operation, specInput(recovery.slice));
  if (JSON.stringify(recoverableOfficialHandoff({ ...input,
    readback: { lifecycle: fresh.lifecycle, executionRaw: preflight } })) !== JSON.stringify(recovery)) return null;
  return { ...recovery, ...(admission ? { admission } : {}) };
}
export async function loadProduct(snapshot) {
  const execution = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-execution-planner/runtime/execution-state.mjs')).href);
  const lifecycle = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs')).href);
  const readiness = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/readiness-result.mjs')).href);
  const provider = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/native-provider.mjs')).href);
  const current = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs')).href);
  const preparation = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs')).href);
  const kernel = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/execution-current.mjs')).href);
  const projection = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs')).href);
  const evidence = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs')).href);
  const proof = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs')).href);
  return { ...execution, ...readiness, ...provider, ...current, ...kernel, ...projection, ...evidence, ...proof,
    validateWorkspace: lifecycle.validateWorkspace, workspaceSnapshot: lifecycle.workspaceSnapshot,
    deriveCloseExecutionDisposition: lifecycle.deriveCloseExecutionDisposition,
    assertPreparationCandidate: preparation.assertPreparationCandidate };
}
function argsForJournal({ journal, operation, route, outcome, slice, readback, readinessResult, turn, durationMs, runnerCount }) {
  const args = ['journal-event', '--journal', journal, '--operation', operation, '--phase', route.phase,
    '--model', route.label, '--effort', route.effort, '--result', outcome.result,
    '--duration-ms', String(durationMs), '--input-bytes', String(Buffer.byteLength(turn.prompt)),
    '--output-bytes', String(Buffer.byteLength(turn.response ?? ''))];
  if (slice) args.push('--slice', slice);
  const state = operation === 'SPEC_READINESS' ? readinessResult?.verdict === 'READY' ? 'GLOBAL_READY'
    : readinessResult?.verdict === 'FINDINGS' ? 'GLOBAL_FINDINGS' : null
    : operation === 'SPEC_CLOSE' ? null
      : operation.startsWith('SPEC_') ? (readback.lifecycle?.status ? `SPEC_${readback.lifecycle.status.toUpperCase()}` : null) : readback.execution?.state;
  if (state) args.push('--resulting-state', state);
  if (operation === 'SPEC_READINESS' && readinessResult) {
    args.push('--readiness-scope', readinessResult.scope,
      '--readiness-snapshot-sha256', readinessResult.snapshotSha256);
  }
  if (Number.isSafeInteger(turn.usage?.input_tokens)) args.push('--input-tokens', String(turn.usage.input_tokens));
  if (Number.isSafeInteger(turn.usage?.output_tokens)) args.push('--output-tokens', String(turn.usage.output_tokens));
  if (runnerCount > 0) args.push('--child-role', 'stnl_validation_runner', '--child-model', 'GPT-6-Luna', '--child-effort', 'medium');
  return args;
}
function specInput(slice) { return slice === null ? null : BigInt(slice.slice('slice-'.length)).toString(10); }

export function privateHomeNeverCreated(state, journal) {
  return state?.privateHomeNotCreated === true && state.status === 'BLOCKED'
    && !state.isolationHomePath && !state.suspendedHome && !state.privateHomeCleanupError
    && state.finalizer === null && state.mainTurns === 0 && state.runnerTurns === 0
    && Array.isArray(state.operations) && state.operations.length === 0
    && Array.isArray(journal?.events) && journal.events.length === 0;
}
export function settledNativeCase(state, ledger) {
  return state?.protocol === 'native-app-server-v1' && state.status === 'PASS'
    && state.pendingObservation == null && ledger?.version === 1
    && Array.isArray(ledger.reservations) && ledger.reservations.length === 0
    && Array.isArray(ledger.turns) && ledger.turns.every(turn => ['completed', 'not_dispatched'].includes(turn.state));
}

export async function runCase({ runRoot, caseId, configuration, snapshotMetadata, maxOperations, mode, product, signal,
  resume = false }) {
  const policy = contextPolicy(configuration), turnLimit = configuration.turnBudget?.maxTurnsPerRun;
  if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) fail('invalid per-run turn budget');
  const caseRoot = path.join(runRoot, caseName(caseId)), workspace = path.join(caseRoot, 'workspace');
  const candidates = path.join(caseRoot, 'candidates'), prompts = path.join(caseRoot, 'prompts');
  const caseConfiguration = configuration.cases.find(item => item.id === caseId);
  if (!caseConfiguration) fail('unknown case');
  const specPath = path.join(workspace, ...caseConfiguration.specPath.split('/'));
  const requirementsPath = path.join(workspace, 'requirements.md'), journal = path.join(caseRoot, 'journal.json');
  const stateFile = path.join(caseRoot, 'case-state.json');
  if (!resume) {
    await fs.mkdir(caseRoot); await fs.mkdir(candidates); await fs.mkdir(prompts); await fs.mkdir(path.join(caseRoot, 'tmp'));
    const preparation = command(['prepare', '--case', caseId, '--output', workspace]);
    if (preparation.exitCode !== 0) fail(preparation.stderr || preparation.stdout);
    const initialized = command(['journal-init', '--output', journal, '--case', caseId,
      '--sentinel-sha', snapshotMetadata.baseSha, '--run-mode', mode,
      '--production-profile', configuration.productionProfile.id]);
    if (initialized.exitCode !== 0) fail(initialized.stderr || initialized.stdout);
  }
  const state = resume ? await readJson(stateFile) : { caseId, status: 'ACTIVE', protocol: 'native-app-server-v1',
    startedAt: new Date().toISOString(), operations: [], workspace, specPath, journal,
    contextPolicy: policy, authorThread: null, threads: {}, runnerTurns: 0, mainTurns: 0 };
  if (state.protocol !== 'native-app-server-v1' || state.workspace !== workspace || state.specPath !== specPath
    || JSON.stringify(state.contextPolicy) !== JSON.stringify(policy)) fail('case identity/context protocol differs');
  let target = { operation: 'SPEC_INIT', slice: null }, readiness = null, preparation = null;
  let pending = resume ? state.pendingObservation ?? null : null;
  if (resume) {
    if (pending !== null) {
      if (!pending.dispatch?.threadId || !pending.dispatch?.turnId || state.status !== 'BLOCKED') fail('observation has no proven existing dispatch');
      target = { operation: pending.operation, slice: pending.slice };
      readiness = state.readiness ?? null; preparation = state.preparation ?? null;
    } else {
    if (state.status !== 'FOCAL_STOP' || state.operations.at(-1)?.outcome?.result !== 'PASS') fail('case is not safely resumable');
    const last = await readJson(state.operations.at(-1).evidencePath), current = await officialReadback(product, specPath);
    if (JSON.stringify(current.execution) !== JSON.stringify(last.officialReadback.execution)
      || current.lifecycle.status !== last.officialReadback.lifecycle.status) fail('official state changed since stop');
    readiness = state.readiness ?? null; preparation = state.preparation ?? null;
    target = nextHandoff(last.operation, { ...current, preparation, product }, readiness);
    if (!target) fail('stopped case has no legal next handoff');
    }
    const previousJournal = await fs.readFile(journal), previousScope = JSON.parse(previousJournal).runMode;
    if (previousScope !== mode) {
      if (previousScope !== 'focal' || mode !== 'case') fail('resume cannot silently change the measured scope');
      // Only this explicitly resumed case advances from diagnostic to case.
      // Keep the prior bytes/raw and every original event; finalization now
      // applies the full case oracle and closure gates rather than focal rules.
      const retained = { finalizer: state.finalizer, journalBase64: previousJournal.toString('base64'), mode: previousScope };
      state.finalizerHistory ??= [];
      if (!state.finalizerHistory.some(item => item.journalBase64 === retained.journalBase64
        && item.mode === retained.mode && item.finalizer?.rawPath === retained.finalizer?.rawPath)) state.finalizerHistory.push(retained);
      await atomicJson(stateFile, state);
      await atomicJson(journal, { ...JSON.parse(previousJournal), runMode: mode });
    }
  }
  state.status = 'ACTIVE'; state.terminal = null;
  await atomicJson(stateFile, state);
  const finalSequence = maxOperations === null ? null : state.operations.length + maxOperations;
  let provider = null, terminal = null;
  try {
    await assertSnapshotIntegrity(runRoot);
    provider = await product.createNativeProvider({ snapshot: path.join(runRoot, 'snapshot'), workspace, evidenceRoot: caseRoot });
    state.transport = { protocol: state.protocol, cliVersion: '0.163.0',
      bundleSha256: hash(JSON.stringify(provider.bundle)),
      requestedPermissions: { approvalPolicy: null, sandbox: null }, effectivePermissions: 'unavailable' };
    await atomicJson(stateFile, state);
    for (let sequence = pending?.sequence ?? state.operations.length + 1; target !== null; sequence++) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      if (finalSequence !== null && sequence > finalSequence) { terminal = { result: 'FOCAL_STOP', blocker: null }; break; }
      const { operation, slice } = target, route = dispatch(configuration, caseId, operation);
      const violation = budgetViolation([...state.operations, target], caseConfiguration.budgets);
      if (violation !== null) { terminal = { result: 'BLOCKED', blocker: 'BUDGET_EXCEEDED', diagnostic: violation.budget }; break; }
      await assertSnapshotIntegrity(runRoot);
      const before = await officialReadback(product, specPath);
      if (operation === 'PLAN' && before.lifecycle.status !== 'ready') fail('PLAN requires ready SPEC');
      if (pending === null && operation === 'REVIEW_PLAN') {
        if (!preparation) fail('REVIEW_PLAN requires the exact returned candidate root');
        await product.assertPreparationCandidate(preparation.candidateExecutionRoot, specPath);
      } else if (pending === null && !operation.startsWith('SPEC_')) await product.preflightExecutionOperation(specPath, operation, slice);
      if (operation === 'SPEC_PROMOTE' && (readiness?.verdict !== 'READY'
        || product.readinessSnapshot(specPath).snapshotSha256 !== readiness.snapshotSha256)) fail('promotion snapshot changed');
      const beforeReadiness = ['SPEC_READINESS', 'SPEC_RESUME'].includes(operation) ? product.readinessSnapshot(specPath) : null;
      let preClose = null;
      if (operation === 'SPEC_CLOSE') {
        preClose = pending?.preClose ?? await retainBeforeClose({ product, specPath, workspace, artifacts: await artifactMetrics(specPath) });
        if (pending === null) await atomicJson(path.join(caseRoot, 'terminal-evidence.json'), preClose);
      }
      const templatePath = path.join(runRoot, 'snapshot', 'templates/prompts', TEMPLATE[operation]);
      const template = await fs.readFile(templatePath, 'utf8');
      const workflowSkill = operation.startsWith('SPEC_')
        ? 'stnl-spec-lifecycle-manager' : product.workflowSkillForOperation(operation);
      const operationId = `${caseId}-${String(sequence).padStart(2, '0')}-${operation}`;
      const prompt = `$${workflowSkill}\n` + renderLauncher(template, { SPEC_PATH: specPath, REQUIREMENTS_SOURCE: requirementsPath,
        SLICE: slice === null ? '' : specInput(slice), READINESS_SCOPE: 'GLOBAL', READINESS_FOCUS: 'not-applicable',
        NEW_INFORMATION: operation === 'SPEC_PROMOTE' ? `GLOBAL READY ${readiness.snapshotSha256}; promote status only.`
          : readiness?.verdict === 'FINDINGS' ? JSON.stringify(readiness.findings) : '',
        REPLAN_REASON: 'Follow the exact current public requirements and handoff.' })
        + (operation === 'REVIEW_PLAN' ? `\nCANDIDATE_EXECUTION_ROOT=${preparation.candidateExecutionRoot}\n` : '')
        + (operation === 'VALIDATE_SLICE' ? '\nSolicito validação integral terminal do estado atual quando admissível pelo contrato normal; se não for admissível, reporte o bloqueio. Não certifique COMPLETE com julgamento apenas local.\n' : '')
        + `\nProject working directory: ${workspace}\nOriginal requirements input: ${requirementsPath}\n`
        + nativeRunnerContext(operation, provider.bundle, path.join(caseRoot, `${operationId}.events.jsonl`));
      const promptFile = path.join(prompts, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.md`);
      if (RUNNER_OPERATIONS.has(operation)) assertNativeLauncher(prompt, { operation, specPath }, specInput(slice));
      if (pending === null) await fs.writeFile(promptFile, prompt, { flag: 'wx' });
      else if (await fs.readFile(promptFile, 'utf8') !== prompt) fail('observation prompt differs from original');
      // Reserve the legal maximum before the principal starts. Native events
      // cannot retroactively prevent a spawn; unexpected children block rather
      // than being called free. No promise of a financial/HTTP limit is made.
      const runnerSlots = ['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(operation) ? 3 : operation === 'VALIDATE_SLICE' ? 2 : 0;
      const admission = pending?.admission ?? await admitOperation({ runRoot, runId: path.basename(runRoot), caseId,
        operation, runnerRequired: runnerSlots > 0, runnerSlots, limit: turnLimit });
      const reserved = [...(pending?.reserved ?? admission.runners)], startedChildren = new Map(pending?.startedChildren ?? []);
      let mainNumber = pending?.mainNumber ?? null, turn = null;
      const role = ['REVIEW_PLAN', 'VALIDATE_SLICE', 'SPEC_READINESS'].includes(operation) ? 'review' : 'author';
      const prior = role === 'author' && policy.regime === 'author-continuity'
        && policy.authorContinuityOperations.includes(operation) ? state.authorThread : null;
      const startedAt = new Date().toISOString(), startedMs = Date.now();
      try {
        if (pending === null) mainNumber = await startReservedTurn(runRoot, admission.main, turnLimit);
        const checkpoint = async dispatch => {
          state.pendingObservation = { sequence, operation, slice, admission, reserved: [...reserved],
            startedChildren: [...startedChildren], mainNumber, dispatch, preClose };
          await atomicJson(stateFile, state);
        };
        turn = await provider.runTurn({ prompt, workflowSkill, model: route.model,
          effort: route.effort, role, priorAuthorThread: prior, operationId, signal,
          observation: pending?.dispatch ?? null,
          onDispatched: checkpoint,
          onUnadmittedChildren: async bindings => {
            for (const binding of bindings) if (await recordUnadmittedChild(runRoot, { caseId, operation, binding })) state.runnerTurns++;
          },
          outputSchema: operation === 'SPEC_READINESS' ? await readJson(path.join(runRoot,
            'snapshot/skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json')) : undefined,
          onChildStarted: async binding => {
            if (startedChildren.has(binding.agentThreadId)) return;
            if (binding.unadmitted) {
              if (await recordUnadmittedChild(runRoot, { caseId, operation, binding })) state.runnerTurns++;
              fail('runner delegated an unadmitted descendant; consumption uncertain');
            }
            const reservation = reserved.shift();
            if (!reservation) {
              if (await recordUnadmittedChild(runRoot, { caseId, operation, binding })) state.runnerTurns++;
              fail('native child outside reserved operation margin; consumption uncertain');
            }
            const number = await startReservedTurn(runRoot, reservation, turnLimit);
            state.runnerTurns++;
            startedChildren.set(binding.agentThreadId, number);
            await checkpoint(state.pendingObservation.dispatch);
          },
          onChildCompleted: async ({ binding }) => settleTurn(runRoot,
            startedChildren.get(binding.agentThreadId), { completed: true, turnStarted: true, threadId: binding.agentThreadId }, turnLimit),
        });
      } catch (error) {
        turn = { completed: false, turnStarted: mainNumber === null ? false : null, threadId: null,
          response: null, captures: [], commandResults: [], error: error.message, errorCode: error.code ?? 'DRIVER_FAILURE', usage: null };
      } finally {
        // An uncertain parent may still spawn: its admitted margin remains
        // reserved until official terminal observation proves it unused.
        if (turn?.completed === true || turn?.turnStarted === false) {
          for (const reservation of reserved) await releaseReservation(runRoot, reservation, turnLimit);
        }
        if (mainNumber !== null) await settleTurn(runRoot, mainNumber, turn, turnLimit);
      }
      const counted = (await readJson(ledgerPath(runRoot))).turns.filter(item => item.caseId === caseId && item.state !== 'not_dispatched');
      state.mainTurns = counted.filter(item => item.role === 'main').length;
      state.runnerTurns = counted.filter(item => item.role === 'runner').length;
      if (role === 'author' && turn.completed) state.authorThread = turn.authorThread;
      const readback = await officialReadback(product, specPath);
      let outcome = { result: 'BLOCKED', blocker: turn.errorCode ?? 'NATIVE_TRANSPORT_UNPROVEN',
        ...(turn.stderrSample ? { stderrSample: turn.stderrSample } : {}) };
      let captureProof = null, closeEvidence = null;
      if (turn.completed) try {
        if (operation === 'PLAN' || operation === 'REPLAN') preparation = await preparationHandoff(product, specPath, turn.commandResults);
        if (operation === 'SPEC_READINESS') {
          if (product.readinessSnapshot(specPath).snapshotSha256 !== beforeReadiness.snapshotSha256) fail('READINESS mutated its snapshot');
          readiness = product.validateReadinessResult(specPath, JSON.parse(turn.response), { scope: 'GLOBAL' });
        }
        if (RUNNER_OPERATIONS.has(operation)) captureProof = assertNativeCaptures(await product.captureCurrentExecution(specPath), turn.captures, product);
        else if (turn.captures.length !== 0) fail('unexpected child outside an admitted runner operation');
        if (operation === 'SPEC_CLOSE') {
          closeEvidence = await finishCloseEvidence({ product, pre: preClose, commandResults: turn.commandResults });
          await atomicJson(path.join(caseRoot, 'terminal-evidence.json'), closeEvidence);
        }
        outcome = decideOutcome(operation, { ...readback, preparation }, true, readiness);
        if (operation === 'SPEC_RESUME' && product.readinessSnapshot(specPath).snapshotSha256 === beforeReadiness.snapshotSha256) {
          outcome = { result: 'BLOCKED', blocker: 'RESUME_NO_MATERIAL_PROGRESS' };
        }
      } catch (error) { outcome = { result: 'BLOCKED', blocker: error.code ?? 'OFFICIAL_READBACK_ERROR', diagnostic: error.message }; }
      const previousEvent = (await readJson(journal)).events[sequence - 1];
      const journalResult = !turn.completed ? { exitCode: 0, pendingObservation: true }
        : previousEvent && pending !== null ? (() => {
          if (previousEvent.operation !== operation || previousEvent.result !== outcome.result) fail('retained journal outcome differs from repeated observation');
          return { exitCode: 0, retainedEvent: previousEvent.index };
        })() : command(argsForJournal({ journal, operation, route, outcome, slice,
        readback: { ...readback, preparation }, readinessResult: readiness,
        turn: { ...turn, prompt }, durationMs: Date.now() - startedMs, runnerCount: startedChildren.size }));
      if (journalResult.exitCode !== 0) outcome = { result: 'BLOCKED', blocker: 'JOURNAL_REJECTED',
        diagnostic: journalResult.stderr, priorOutcome: outcome };
      const evidencePath = path.join(caseRoot, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}${pending === null ? '' : `.observation-${randomUUID()}`}.json`);
      await atomicJson(evidencePath, { sequence, operation, slice, promptFile, templatePath, promptSha256: hash(prompt),
        startedAt, endedAt: new Date().toISOString(), dispatch: route,
        context: { ...policy, role, priorThreadId: prior?.threadId ?? null, threadId: turn.threadId,
          inheritedAuthorHistory: prior !== null }, turn, normalizedUsage: null, captureProof,
        runner: { turns: startedChildren.size, capturedReceipts: turn.captures.length },
        officialReadback: { lifecycle: readback.lifecycle, execution: readback.execution }, preparation,
        readinessResult: readiness, closeEvidence: closeEvidence ? path.join(caseRoot, 'terminal-evidence.json') : null,
        journal: journalResult, outcome });
      const recorded = { operation, slice, outcome, evidencePath, threadId: turn.threadId };
      if (pending === null) state.operations.push(recorded); else state.operations[sequence - 1] = recorded;
      if (turn.completed && ['PASS', 'NEEDS_FIX'].includes(outcome.result)) state.pendingObservation = null;
      state.readiness = readiness; state.preparation = preparation;
      await atomicJson(stateFile, state);
      terminal = outcome;
      announce({ runId: path.basename(runRoot), caseId, operation, slice, result: outcome.result,
        state: readback.execution.state, mainTurns: state.mainTurns, runnerTurns: state.runnerTurns,
        ...await budgetSnapshot(runRoot), artifacts: caseRoot });
      if (outcome.result === 'BLOCKED' || outcome.result === 'FAIL') break;
      pending = null;
      target = nextHandoff(operation, { ...readback, preparation, product }, readiness);
      if (!target && operation !== 'SPEC_CLOSE') { terminal = { result: 'BLOCKED', blocker: 'NO_OFFICIAL_HANDOFF' }; break; }
    }
  } catch (error) {
    terminal = { result: error.code === 'PAUSED_BUDGET_OR_QUOTA' ? error.code : 'BLOCKED',
      blocker: error.code ?? 'DRIVER_FAILURE', diagnostic: error.message,
      ...(error.stderrSample ? { stderrSample: error.stderrSample } : {}) };
  } finally {
    provider?.close();
    const rawPath = path.join(caseRoot, resume ? `raw-resume-${state.operations.length}.json` : 'raw.json');
    const args = ['finalize', '--workspace', workspace, '--case', caseId, '--spec', specPath, '--journal', journal, '--output', rawPath];
    if (await exists(path.join(caseRoot, 'terminal-evidence.json'))) args.push('--terminal-evidence', path.join(caseRoot, 'terminal-evidence.json'));
    const finalizer = await exists(specPath) ? command(args) : null;
    const raw = await readJson(rawPath).catch(() => null);
    state.status = ['FOCAL_STOP', 'PAUSED_BUDGET_OR_QUOTA'].includes(terminal?.result) ? terminal.result
      : terminal?.result === 'BLOCKED' || terminal?.result === 'FAIL' ? 'BLOCKED' : raw?.status ?? 'BLOCKED';
    state.terminal = terminal; state.endedAt = new Date().toISOString();
    state.finalizer = finalizer === null ? null : { exitCode: finalizer.exitCode,
      diagnostic: finalizer.stderr || finalizer.stdout, rawPath: await exists(rawPath) ? rawPath : null };
    try { await assertSnapshotIntegrity(runRoot); state.integrity = 'PASS'; }
    catch (error) { state.integrity = `BLOCKED: ${error.message}`; state.status = 'BLOCKED'; }
    await atomicJson(stateFile, state);
  }
  return { caseId, status: state.status, terminal: state.terminal, operations: state.operations.length,
    mainTurns: state.mainTurns, runnerTurns: state.runnerTurns, rawPath: state.finalizer?.rawPath ?? null };
}

async function run(options) {
  if (process.env.STNL_OFFLINE_PROVIDER_CONTEXT !== undefined) fail('retired SDK offline context cannot select a native client');
  const offline = options.offline ?? null;
  if (offline !== null) {
    const { assertOfflineSdk, OFFLINE_MARKER } = await import('../../../agents/codex/runtime/offline-provider-context.mjs');
    const owner = await readJson(path.join(ROOT, '.offline-fixture-owner.json'));
    if (offline.mode !== 'OFFLINE_TEST_ONLY' || typeof offline.createNativeProvider !== 'function'
      || !path.basename(ROOT).startsWith('stnl-offline-checkout-') || owner.root !== ROOT
      || owner.inode !== (await fs.lstat(ROOT)).ino
      || await fs.readFile(path.join(ROOT, '.offline-owned'), 'utf8') !== OFFLINE_MARKER) fail('offline provider is not an owned disposable fixture');
    await assertOfflineSdk(offline.sdk, ROOT);
  }
  const id = options.resumeId ?? `run-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  if (options.resumeId) await assertRun(id);
  await acquire(id);
  const runRoot = path.join(RUNS, id);
  const signalController = new AbortController();
  const onSignal = () => signalController.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let summary;
  try {
    if (!options.resumeId) {
      await fs.mkdir(runRoot);
      await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), MARKER, { flag: 'wx' });
    }
    const configuration = await readJson(MANIFEST);
    const turnLimit = configuration.turnBudget?.maxTurnsPerRun;
    if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) fail('benchmark turnBudget.maxTurnsPerRun must be a positive integer');
    if (options.resumeId) {
      if (!await exists(ledgerPath(runRoot))) fail('run turn budget ledger is missing; this focal run cannot be resumed safely');
    } else {
      await initializeTurnBudget(runRoot, turnLimit);
    }
    const snapshotMetadata = options.resumeId
      ? (await readJson(path.join(runRoot, 'run.json'))).snapshot
      : await createSnapshot(runRoot, { executionMode: offline?.mode, offlineSdk: offline?.sdk });
    if (options.resumeId) await assertSnapshotIntegrity(runRoot);
    const product = await loadProduct(path.join(runRoot, 'snapshot'));
    if (offline !== null) product.createNativeProvider = offline.createNativeProvider;
    const previous = options.resumeId ? await readJson(path.join(runRoot, 'run.json')) : null;
    const mode = options.maxOperations !== null ? 'focal' : options.full ? 'full' : 'case';
    if (previous && (!['FOCAL_STOP', 'BLOCKED'].includes(previous.status) || previous.cases.length !== 1
      || previous.profile !== 'production-v3')) {
      fail('only a stopped single case or scoped pending observation can be resumed');
    }
    const caseId = previous?.cases[0] ?? options.caseId;
    const runInfo = previous
      ? { ...previous, status: 'ACTIVE', mode: options.maxOperations !== null ? 'focal' : 'case', resumedAt: new Date().toISOString() }
      : { runId: id, status: 'ACTIVE', mode, cases: options.full ? ['A', 'B', 'C'] : [caseId],
        snapshot: snapshotMetadata, startedAt: new Date().toISOString(), profile: 'production-v3' };
    await atomicJson(path.join(runRoot, 'run.json'), runInfo);
    announce({ runId: id, status: 'ACTIVE', mode, artifacts: runRoot, sourceFunctionalSha256: snapshotMetadata.sourceFunctionalSha256,
      ...await budgetSnapshot(runRoot) });
    const results = {};
    results.A = options.full || caseId === 'A'
      ? await runCase({ runRoot, caseId: 'A', configuration, snapshotMetadata, maxOperations: options.maxOperations,
        mode: runInfo.mode, product, signal: signalController.signal, resume: !!options.resumeId }) : { status: 'NOT_RUN' };
    if (options.full && results.A.status === 'PASS' && !signalController.signal.aborted) {
      const [b, c] = await Promise.allSettled(['B', 'C'].map((caseId) => runCase({ runRoot, caseId,
        configuration, snapshotMetadata, maxOperations: null, mode, product, signal: signalController.signal })));
      results.B = b.status === 'fulfilled' ? b.value : { status: 'BLOCKED', error: String(b.reason) };
      results.C = c.status === 'fulfilled' ? c.value : { status: 'BLOCKED', error: String(c.reason) };
    } else if (options.full) results.B = { status: 'NOT_RUN' }, results.C = { status: 'NOT_RUN' };
    else if (caseId !== 'A') results[caseId] = await runCase({ runRoot, caseId,
      configuration, snapshotMetadata, maxOperations: options.maxOperations,
      mode: runInfo.mode, product, signal: signalController.signal, resume: !!options.resumeId });
    const allPass = (options.full ? ['A', 'B', 'C'] : [caseId]).every((name) => results[name]?.status === 'PASS');
    const focalStop = options.maxOperations !== null && results[caseId]?.status === 'FOCAL_STOP';
    const budgetPaused = Object.values(results).some((result) => result?.status === 'PAUSED_BUDGET_OR_QUOTA');
    summary = { runId: id, status: allPass ? 'PASS' : signalController.signal.aborted ? 'CANCELLED'
      : budgetPaused ? 'PAUSED_BUDGET_OR_QUOTA' : focalStop ? 'FOCAL_STOP' : 'BLOCKED',
      mode: runInfo.mode, cases: results, snapshotSha256: snapshotMetadata.snapshotSha256,
      sourceFunctionalSha256: snapshotMetadata.sourceFunctionalSha256,
      ...await budgetSnapshot(runRoot), endedAt: new Date().toISOString(), artifacts: runRoot };
    await atomicJson(path.join(runRoot, 'summary.json'), summary);
    await atomicJson(path.join(runRoot, 'run.json'), { ...runInfo, status: summary.status, endedAt: summary.endedAt });
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    await release(id);
  }
  announce(summary);
  return summary.status === 'PASS' || summary.status === 'FOCAL_STOP' ? 0 : summary.status === 'PAUSED_BUDGET_OR_QUOTA' ? 3 : 1;
}

async function status(id) {
  await fs.mkdir(RUNS, { recursive: true });
  if (id) {
    const root = await assertRun(id);
    const runInfo = await readJson(path.join(root, 'run.json')).catch(() => null);
    announce({ runId: id, status: runInfo?.status ?? 'UNKNOWN', mode: runInfo?.mode ?? null,
      cases: (await readJson(path.join(root, 'summary.json')).catch(() => null))?.cases ?? null,
      snapshotSha256: runInfo?.snapshot?.snapshotSha256 ?? null,
      sourceFunctionalSha256: runInfo?.snapshot?.sourceFunctionalSha256 ?? null,
      ...await budgetSnapshot(root), artifacts: root });
    return 0;
  }
  const runs = [];
  for (const entry of await fs.readdir(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const root = await assertRun(entry.name).catch(() => null);
    if (!root) continue;
    runs.push({ runId: entry.name, summary: await readJson(path.join(root, 'summary.json')).catch(() => null) });
  }
  announce({ kind: 'status', active: await readJson(ACTIVE).catch(() => null), turnBudget: null,
    runs: runs.sort((a, b) => b.runId.localeCompare(a.runId)) });
  return 0;
}
async function inspect(id, caseId) {
  const root = await assertRun(id);
  const selected = caseId ? [caseId] : ['A', 'B', 'C'];
  const cases = {};
  for (const name of selected) {
    const state = await readJson(path.join(root, caseName(name), 'case-state.json')).catch(() => null);
    if (state) {
      const lastEvidence = state.operations.length > 0
        ? await readJson(state.operations.at(-1).evidencePath).catch(() => null) : null;
      cases[name] = { status: state.status, workspace: state.workspace,
      prompts: path.join(root, caseName(name), 'prompts'), events: path.join(root, caseName(name), 'events.jsonl'),
      tmp: path.join(root, caseName(name), 'tmp'), operations: state.operations,
      timeline: state.operations.map((item) => `${item.operation}${item.slice ? ` ${item.slice}` : ''}:${item.outcome?.result ?? '?'}`),
      officialState: lastEvidence?.officialReadback?.execution?.state ?? lastEvidence?.officialReadback?.lifecycle?.status ?? null,
      recovery: lastEvidence?.officialReadback?.execution?.requiredRecoveryHandoff ?? null,
      finalizer: state.finalizer, terminal: state.terminal };
    }
  }
  announce({ kind: 'inspect', runId: id, root, snapshot: path.join(root, 'snapshot'), cases });
  return 0;
}
async function clean(id) {
  const root = await assertRun(id);
  await assertInactive(id);
  if (!await exists(path.join(root, 'summary.json'))) fail('run has no preserved summary; inspect it before cleanup');
  async function rejectSymlinks(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('owned run contains a symlink');
      if (entry.isDirectory()) await rejectSymlinks(path.join(directory, entry.name));
    }
  }
  await rejectSymlinks(root);
  const ledger = await readJson(ledgerPath(root)).catch(() => null);
  if (ledger && (ledger.reservations?.length || ledger.turns?.some(turn => ['dispatched', 'uncertain'].includes(turn.state)))) fail('run has pending/uncertain native admission; preserve it');
  const suspended = []; let nativeCases = 0;
  for (const name of await fs.readdir(root)) {
    if (name.startsWith('case-')) {
      const state = await readJson(path.join(root, name, 'case-state.json')).catch(() => null);
      if (!state || state.status === 'ACTIVE') fail('run contains an active or unclean case');
      if (state.protocol === 'native-app-server-v1') {
        nativeCases++;
        if (!settledNativeCase(state, ledger)) fail('native case is not demonstrably settled');
        validateNativeLedger(ledger, state, id, { settled: true });
        const product = await loadProduct(path.join(root, 'snapshot'));
        const proof = await readJson(path.join(root, name, 'terminal-evidence.json'));
        const { validateTerminalEvidence } = await import('./native-evidence.mjs');
        await validateTerminalEvidence({ product, evidence: proof, specPath: state.specPath, workspace: state.workspace });
        continue;
      }
      if (state.privateHomeSuspended === true && state.suspendedHome) suspended.push(state);
      else if (state.privateHomeRemoved !== true
        && !privateHomeNeverCreated(state, await readJson(path.join(root, name, 'journal.json')).catch(() => null))) {
        fail('run contains an active or unclean case');
      }
    }
  }
  if (suspended.length > 0) fail('historical private home is not eligible for native cleanup');
  // Retain the sole source before removing it from the active run namespace.
  // A same-filesystem rename is atomic: interruption cannot delete both copies.
  // Archives are explicit local material, not permanent product requirements.
  const retained = path.join(RUNS, '.retained');
  await fs.mkdir(retained, { recursive: true });
  if (await fs.realpath(retained) !== retained || (await fs.lstat(retained)).isSymbolicLink()) fail('retention root is not canonical');
  const retentionMarker = path.join(retained, '.sentinel-retention-owned');
  if (await exists(retentionMarker)) {
    if (await fs.readFile(retentionMarker, 'utf8') !== 'sentinel-local-retention-v1\n') fail('retention marker differs');
  } else await fs.writeFile(retentionMarker, 'sentinel-local-retention-v1\n', { flag: 'wx', mode: 0o600 });
  const destination = path.join(retained, id);
  if (await exists(destination)) fail('retention destination already exists');
  if (nativeCases > 0) {
    const { exportMeasurement } = await import('./benchmark-measurement.mjs');
    const expected = await exportMeasurement(id), retainedFile = path.join(root, 'measurement-retained.json');
    if (await exists(retainedFile)) {
      if (JSON.stringify(await readJson(retainedFile)) !== JSON.stringify(expected)) fail('retained export differs from the current run');
    } else await fs.writeFile(retainedFile, `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  await assertInactive(id); await rejectSymlinks(root);
  await fs.rename(root, destination);
  announce({ runId: id, cleaned: true, retained: destination });
  return 0;
}
function parse(argv) {
  const [verb, ...tokens] = argv;
  if (!new Set(['run', 'status', 'inspect', 'clean']).has(verb)) fail('usage: benchmark-manager.mjs {run|status|inspect|clean}');
  const values = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index];
    if (key === '--json') { if (values.json) fail('duplicate --json'); values.json = true; continue; }
    if (key === '--full') { if (values.full) fail('duplicate --full'); values.full = true; continue; }
    if (!new Set(['--case', '--run', '--resume', '--max-operations']).has(key) || values[key] !== undefined || !tokens[index + 1]) fail('invalid manager option');
    values[key] = tokens[++index];
  }
  return { verb, values };
}
export async function main(argv, { offline = null } = {}) {
  const { verb, values } = parse(argv);
  reporter = createReporter({ format: values.json ? 'json' : 'human', isTTY: process.stdout.isTTY,
    width: process.stdout.columns ?? 100, noColor: Object.hasOwn(process.env, 'NO_COLOR') });
  if (verb === 'run') {
    const caseId = values['--case'] ?? null;
    const resumeId = values['--resume'] ?? null;
    if (values['--run'] || [caseId !== null, !!values.full, resumeId !== null].filter(Boolean).length !== 1
      || (caseId && !['A', 'B', 'C'].includes(caseId))) fail('run requires one of --case A|B|C, --full, or --resume <id>');
    const maxOperations = values['--max-operations'] === undefined ? null : Number(values['--max-operations']);
    if (maxOperations !== null && (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || values.full)) fail('invalid focal operation limit');
    return run({ caseId, full: !!values.full, resumeId, maxOperations, offline });
  }
  if (values.full || values['--resume'] || values['--case'] && verb !== 'inspect' || values['--max-operations']) fail('invalid manager option for command');
  if (verb === 'status') return status(values['--run'] ?? null);
  if (!values['--run']) fail(`${verb} requires --run <id>`);
  if (verb === 'inspect') return inspect(values['--run'], values['--case'] ?? null);
  return clean(values['--run']);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
