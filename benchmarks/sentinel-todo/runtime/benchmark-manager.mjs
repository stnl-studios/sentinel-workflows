#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertSnapshotIntegrity, createSnapshot } from './benchmark-snapshot.mjs';
import { createReporter } from './benchmark-ui.mjs';
import { budgetViolation } from './benchmark.mjs';

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
  MATERIALIZE_TASKS: 'TASKS', REVIEW_TASKS: 'REVIEW_VALIDATE',
  EXECUTE_SLICE: 'EXECUTE', APPLY_FINDINGS: 'EXECUTE', VALIDATE_SLICE: 'REVIEW_VALIDATE',
};
const TEMPLATE = {
  SPEC_INIT: 'spec-init.md', SPEC_READINESS: 'spec-readiness.md',
  SPEC_RESUME: 'spec-resume.md', SPEC_PROMOTE: 'spec-resume.md', SPEC_CLOSE: 'spec-close.md',
  PLAN: 'execution-plan.md', REPLAN: 'execution-replan.md', REVIEW_PLAN: 'execution-plan-review.md',
  MATERIALIZE_TASKS: 'execution-tasks.md', REVIEW_TASKS: 'execution-tasks-review.md',
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
export async function admitOperation({ runRoot, runId, caseId, operation, runnerRequired, limit }) {
  return updateLedger(runRoot, (ledger) => {
    if (availableTurns(ledger) < (runnerRequired ? 2 : 1)) throw budgetPause();
    const main = randomUUID();
    const runner = runnerRequired ? randomUUID() : null;
    ledger.reservations.push({ id: main, runId, caseId, role: 'main', operation,
      reservedAt: new Date().toISOString() });
    if (runner !== null) ledger.reservations.push({ id: runner, runId, caseId,
      role: 'runner', operation, reservedAt: new Date().toISOString() });
    return { main, runner };
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
    if (!entry || entry.state !== 'dispatched') fail('turn ledger settlement is invalid');
    entry.endedAt = new Date().toISOString();
    entry.threadId = turn?.threadId ?? null;
    if (turn?.turnStarted === false) {
      entry.state = 'not_dispatched';
      ledger.total -= 1;
    } else entry.state = turn?.completed ? 'completed' : 'failed';
  }, limit);
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

export function renderManagedLauncher(template, values, discoveryInstructions, managedSliceContext = null) {
  if (typeof discoveryInstructions !== 'string' || discoveryInstructions.trim() === '') fail('managed discovery context is missing');
  const invocation = managedSliceContext === null ? '' : [
    'This invocation uses the managed slice runner. The manager supplies STNL_MANAGED_CONTEXT and STNL_RUNNER_ADAPTER.',
    'Run node "$STNL_MANAGED_PREFLIGHT" before artifact reads or mutation; it takes no path or slice arguments.',
    'Delegate independent checks through node "$STNL_MANAGED_RUNNER_BRIDGE" with the invoked skill\'s existing semantic payload on stdin; it takes no path or operation arguments.',
    'This mode is selected by the manager context, not by native agent-tool availability or an environment inventory.',
    '',
  ].join('\n');
  return `${invocation}${renderLauncher(template, values)}\n${discoveryInstructions}\n`;
}

export function runTemplateTurn(product, input) {
  // Each launcher invocation is a new chat. Runner-local format repair uses
  // its own transport call and may continue only that runner's current thread.
  return product.runCodexTurn({ ...input, threadId: null });
}

export function assertManagedSliceLauncher(prompt, context, numericSlice) {
  const declarations = [...prompt.matchAll(/^([A-Z_]+)=(.*)$/gmu)];
  const expected = { SPEC_PATH: context.specPath, OPERATION: context.operation, SLICE: numericSlice };
  for (const [name, value] of Object.entries(expected)) {
    const matches = declarations.filter((match) => match[1] === name);
    if (matches.length !== 1 || matches[0][2] !== value) fail(`managed launcher ${name} disagrees with official context`);
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
    return ['ready', 'draft', 'blocked'].includes(lifecycle?.status) && execution?.state === 'EMPTY'
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_INIT_INVALID' };
  }
  if (operation === 'SPEC_READINESS') {
    if (readinessResult === null || execution?.state !== 'EMPTY') return { result: 'BLOCKED', blocker: 'READINESS_RESULT_INVALID' };
    if (readinessResult.verdict === 'READY') return { result: 'PASS', blocker: null };
    if (readinessResult.findings.some((finding) => finding.action === 'DECISION_REQUIRED')) {
      return { result: 'BLOCKED', blocker: 'BLOCKED_REQUIRED_DECISION' };
    }
    return { result: 'NEEDS_FIX', blocker: null };
  }
  if (operation === 'SPEC_RESUME') {
    return ['ready', 'draft', 'blocked'].includes(lifecycle?.status) && execution?.state === 'EMPTY'
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_RESUME_INVALID' };
  }
  if (operation === 'SPEC_PROMOTE') {
    return lifecycle?.status === 'ready' && execution?.state === 'EMPTY'
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_PROMOTION_INVALID' };
  }
  if (operation === 'SPEC_CLOSE') {
    return lifecycle?.status === 'closed' && lifecycle?.closed === true
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_CLOSE_BLOCKED' };
  }
  if (execution?.error || BLOCKED_STATES.has(execution?.state)) {
    return { result: 'BLOCKED', blocker: execution?.error ? 'OFFICIAL_READBACK_ERROR' : `OFFICIAL_${execution.state}` };
  }
  if (operation === 'VALIDATE_SLICE' && execution?.state === 'VALIDATION_NEEDS_FIX') return { result: 'NEEDS_FIX', blocker: null };
  const accepted = {
    PLAN: ['PLANNED_DRAFT'], REVIEW_PLAN: ['PLANNED_READY', 'PENDING_REPLAN_READY'],
    MATERIALIZE_TASKS: ['MATERIALIZED_PRISTINE', 'EXECUTION_STARTED', 'IMPLEMENTED_AWAITING_VALIDATION', 'FINDINGS_CORRECTED'],
    REVIEW_TASKS: ['MATERIALIZED_PRISTINE'],
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
  const preflight = await product.preflightExecutionOperation(specPath, recovery.operation, specInput(recovery.slice));
  if (JSON.stringify(recoverableOfficialHandoff({ ...input,
    readback: { lifecycle: fresh.lifecycle, executionRaw: preflight } })) !== JSON.stringify(recovery)) return null;
  return recovery;
}
async function loadProduct(snapshot) {
  const execution = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-execution-planner/runtime/execution-state.mjs')).href);
  const lifecycle = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs')).href);
  const readiness = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/readiness-result.mjs')).href);
  const sdk = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/sdk-transport.mjs')).href);
  const usage = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/usage-accounting.mjs')).href);
  const home = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/isolated-home.mjs')).href);
  const runner = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/validation-runner.mjs')).href);
  const managedContext = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs')).href);
  const broker = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/runner-broker.mjs')).href);
  return { ...execution, validateWorkspace: lifecycle.validateWorkspace, ...readiness, ...sdk, ...usage,
    ...home, ...runner, ...broker, ...managedContext };
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
      : operation.startsWith('SPEC_') ? `SPEC_${readback.lifecycle?.status?.toUpperCase()}` : readback.execution?.state;
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

export async function runCase({ runRoot, caseId, configuration, snapshotMetadata, maxOperations, mode, product, signal, resume = false }) {
  const turnLimit = configuration.turnBudget?.maxTurnsPerRun;
  if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) fail('benchmark turnBudget.maxTurnsPerRun must be a positive integer');
  const caseRoot = path.join(runRoot, caseName(caseId));
  if (!resume) await fs.mkdir(caseRoot);
  const workspace = path.join(caseRoot, 'workspace');
  const candidates = path.join(caseRoot, 'candidates');
  const tmpdir = path.join(caseRoot, 'tmp');
  const prompts = path.join(caseRoot, 'prompts');
  if (!resume) {
    await Promise.all([fs.mkdir(candidates), fs.mkdir(tmpdir), fs.mkdir(prompts)]);
    const preparation = command(['prepare', '--case', caseId, '--output', workspace]);
    if (preparation.exitCode !== 0) fail(`case ${caseId} seed preparation failed: ${preparation.stderr || preparation.stdout}`);
  }
  const caseConfiguration = configuration.cases.find((item) => item.id === caseId);
  const specPath = path.join(workspace, ...caseConfiguration.specPath.split('/'));
  const requirementsPath = path.join(workspace, 'requirements.md');
  const journal = path.join(caseRoot, 'journal.json');
  if (!resume) {
    const journalInit = command(['journal-init', '--output', journal, '--case', caseId,
      '--sentinel-sha', snapshotMetadata.baseSha, '--run-mode', mode,
      '--production-profile', configuration.productionProfile.id]);
    if (journalInit.exitCode !== 0) fail(`case ${caseId} journal initialization failed: ${journalInit.stderr || journalInit.stdout}`);
  }
  let home = null;
  const caseState = resume ? await readJson(path.join(caseRoot, 'case-state.json'))
    : { caseId, status: 'ACTIVE', startedAt: new Date().toISOString(), operations: [],
      workspace, specPath, journal, threads: { author: null }, runnerTurns: 0, mainTurns: 0 };
  const mainUsage = product.createUsageNormalizer({ baseline: product.ZERO_USAGE, source: 'main' });
  const runnerUsage = product.createUsageNormalizer({ baseline: product.ZERO_USAGE, source: 'runner' });
  if (resume) {
    for (const earlier of caseState.operations) {
      const recorded = await readJson(earlier.evidencePath);
      mainUsage.observe({ threadId: earlier.threadId, segment: path.basename(runRoot),
        usage: recorded.turn?.usage, eventId: `${caseId}-${recorded.sequence}-${earlier.operation}` });
    }
  }
  let target = { operation: 'SPEC_INIT', slice: null };
  let pendingRecovery = null;
  let pendingReadinessResult = null;
  if (resume) {
    if (caseState.status !== 'FOCAL_STOP' || caseState.terminal?.result !== 'FOCAL_STOP'
      || caseState.privateHomeSuspended !== true || !caseState.suspendedHome || caseState.workspace !== workspace
      || caseState.specPath !== specPath || caseState.journal !== journal
      || caseState.operations.length === 0) fail('focal case is not safely resumable');
    const last = caseState.operations.at(-1);
    if (last.outcome?.result !== 'PASS') fail('last focal operation did not pass');
    const prior = await readJson(last.evidencePath);
    const current = await officialReadback(product, specPath);
    if (current.execution?.error || current.lifecycle?.error
      || current.execution?.state !== prior.officialReadback?.execution?.state
      || current.execution?.currentFingerprint !== prior.officialReadback?.execution?.currentFingerprint
      || current.lifecycle?.status !== prior.officialReadback?.lifecycle?.status) {
      fail('official state changed since focal stop');
    }
    pendingReadinessResult = prior.readinessResult ?? null;
    target = nextHandoff(last.operation, { ...current, product }, pendingReadinessResult);
    if (target === null) fail('focal case has no legal next handoff');
    caseState.status = 'ACTIVE';
    caseState.terminal = null;
    caseState.resumedAt = new Date().toISOString();
  }
  const finalSequence = maxOperations === null ? null : caseState.operations.length + maxOperations;
  await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
  let terminal = null;
  try {
    const homeInput = { runId: path.basename(runRoot), caseId,
      snapshot: path.join(runRoot, 'snapshot'), workspace, candidates, tmpdir };
    home = resume ? await product.resumeIsolatedHome({ ...homeInput, suspended: caseState.suspendedHome })
      : await product.prepareIsolatedHome(homeInput);
    caseState.privateHomeSuspended = false;
    caseState.isolationHomePath = home.privateHome;
    const auth = await product.verifyIsolatedHome(home);
    caseState.isolation = auth;
    await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
    for (let sequence = caseState.operations.length + 1; target !== null; sequence += 1) {
      if (signal.aborted) { terminal = { result: 'BLOCKED', blocker: 'CANCELLED' }; break; }
      if (sequence > caseConfiguration.budgets.maxWorkflowEvents) { terminal = { result: 'BLOCKED', blocker: 'WORKFLOW_EVENT_LIMIT' }; break; }
      if (finalSequence !== null && sequence > finalSequence) { terminal = { result: 'FOCAL_STOP', blocker: null }; break; }
      await assertSnapshotIntegrity(runRoot);
      const { operation, slice } = target;
      const currentRecovery = pendingRecovery;
      pendingRecovery = null;
      const violation = budgetViolation([...caseState.operations, { operation, slice }], caseConfiguration.budgets);
      if (violation !== null) {
        terminal = { result: 'BLOCKED', blocker: 'BUDGET_EXCEEDED', diagnostic: violation.budget };
        break;
      }
      caseState.pendingTarget = target;
      await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
      const route = dispatch(configuration, caseId, operation);
      if (operation === 'PLAN' && (await officialReadback(product, specPath)).lifecycle?.status !== 'ready') {
        fail('PLAN requires an effectively ready SPEC');
      }
      if (operation === 'SPEC_CLOSE' && (await officialReadback(product, specPath)).execution?.state !== 'COMPLETE') {
        fail('benchmark CLOSE requires official COMPLETE');
      }
      if (operation === 'SPEC_PROMOTE') {
        if (pendingReadinessResult?.verdict !== 'READY'
          || product.readinessSnapshot(specPath).snapshotSha256 !== pendingReadinessResult.snapshotSha256) {
          fail('ready promotion requires the unchanged evaluated snapshot');
        }
      }
      let officialPreflight = null;
      let managedSliceContext = null;
      if (!operation.startsWith('SPEC_')) {
        const preflight = await product.preflightExecutionOperation(specPath, operation, specInput(slice));
        if (currentRecovery !== null && (preflight.state !== currentRecovery.state
          || preflight.currentFingerprint !== currentRecovery.authority
          || preflight.recoveryTargets?.length !== 1
          || JSON.stringify(preflight.recoveryTargets[0]) !== JSON.stringify(currentRecovery.target))) {
          fail('official recovery authority changed before dispatch');
        }
        if (RUNNER_OPERATIONS.has(operation)) {
          officialPreflight = { exitCode: 0, operation, slice, inputSlice: specInput(slice),
            specPath, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
            legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
          managedSliceContext = await product.createManagedSliceContext({ officialPreflight, workspace,
            snapshot: path.join(runRoot, 'snapshot'),
            adapterPath: home?.env?.STNL_RUNNER_ADAPTER ?? path.join(runRoot, 'snapshot', 'agents/codex/runtime/validation-runner.mjs'),
            bridgePath: path.join(runRoot, 'snapshot', 'agents/codex/runtime/managed-runner-bridge.mjs'),
            preflightPath: path.join(runRoot, 'snapshot', 'agents/codex/runtime/managed-slice-preflight.mjs') });
        }
      }
      const templatePath = path.join(runRoot, 'snapshot', 'templates', 'prompts', TEMPLATE[operation]);
      const template = await fs.readFile(templatePath, 'utf8');
      const newInformation = operation === 'SPEC_PROMOTE'
        ? `GLOBAL/READY confirmado para ${pendingReadinessResult?.snapshotSha256}. Promova somente o status draft → ready, sem alterar conteúdo.`
        : pendingReadinessResult?.verdict === 'FINDINGS' ? [
          `Fonte autorizada: ${requirementsPath}`,
          `Achados GLOBAL do snapshot ${pendingReadinessResult.snapshotSha256}:`,
          ...pendingReadinessResult.findings.map((finding) => `${finding.id} | ${finding.path} | ${finding.evidence}`),
          'Refine somente o que as fontes existentes sustentam. Se a resposta exigir decisão de produto, bloqueie com pergunta concreta.',
        ].join('\n') : '';
      const values = { SPEC_PATH: specPath, REQUIREMENTS_SOURCE: requirementsPath,
        READINESS_SCOPE: 'GLOBAL', READINESS_FOCUS: 'not-applicable',
        NEW_INFORMATION: newInformation,
        REPLAN_REASON: 'official execution readback requires replanning',
        SLICE: slice === null ? '' : specInput(slice) };
      const workflowSkill = operation.startsWith('SPEC_') ? 'stnl-spec-lifecycle-manager' : product.workflowSkillForOperation(operation);
      const prompt = renderManagedLauncher(template, values,
        product.managedDiscoveryInstructions({ env: home.env, cwd: workspace, workflowSkill }), managedSliceContext);
      if (managedSliceContext !== null) {
        assertManagedSliceLauncher(prompt, managedSliceContext, specInput(slice));
      }
      const promptFile = path.join(prompts, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.md`);
      await fs.writeFile(promptFile, prompt, { flag: 'wx' });
      const operationId = `${caseId}-${String(sequence).padStart(2, '0')}-${operation}`;
      const eventsPath = path.join(caseRoot, 'events.jsonl');
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const beforeReadiness = operation === 'SPEC_READINESS' ? product.readinessSnapshot(specPath) : null;
      const beforeResume = operation === 'SPEC_RESUME' ? product.readinessSnapshot(specPath) : null;
      const runnerTurnsBefore = caseState.runnerTurns;
      const runnerUsageObservations = [];
      const runnerEventPaths = [];
      let broker = null;
      const admission = await admitOperation({ runRoot, runId: path.basename(runRoot), caseId, operation,
        runnerRequired: officialPreflight !== null, limit: turnLimit });
      let runnerReservation = admission.runner;
      let currentRunnerNumber = null;
      let mainTurnNumber;
      const turnEnv = managedSliceContext === null ? home.env
        : product.managedEnvironment(home.env, managedSliceContext);
      let providerConfigError = null;
      let runnerTransportFailed = false;
      try {
        if (officialPreflight !== null) {
          broker = await product.startOfficialRunnerBroker({ workspace, tmpdir, operation, sequence, slice,
          officialPreflight,
          invoke: (request) => product.invokeIndependentRunner({
            ...request, snapshot: path.join(runRoot, 'snapshot'), workspace, tmpdir, env: turnEnv,
            onBeforeTurn: async () => {
              const reservation = runnerReservation ?? await reserveExtraRunner({ runRoot, runId: path.basename(runRoot), caseId, operation, limit: turnLimit });
              runnerReservation = null;
              currentRunnerNumber = await startReservedTurn(runRoot, reservation, turnLimit);
              announce({ kind: 'progress', status: 'RUNNER_STARTED', runId: path.basename(runRoot), caseId,
                operation, slice, stage: 'independent runner', durationMs: Date.now() - startedMs,
                mainTurns: caseState.mainTurns, runnerTurns: caseState.runnerTurns + 1,
                ...await budgetSnapshot(runRoot), artifacts: caseRoot });
            },
            onTurn: async ({ turn: runnerTurn, eventsPath: runnerEventsPath }) => {
              runnerEventPaths.push(runnerEventsPath);
              runnerTransportFailed ||= runnerTurn.completed !== true || runnerTurn.error != null
                || runnerTurn.processError != null || runnerTurn.errorEvent != null;
              providerConfigError ??= providerConfigurationError([], runnerTurn.providerError ?? runnerTurn.errorEvent ?? null);
              await settleTurn(runRoot, currentRunnerNumber, runnerTurn, turnLimit);
              if (runnerTurn.turnStarted !== false) caseState.runnerTurns += 1;
              caseState.lastRunnerThread = runnerTurn.threadId;
              runnerUsageObservations.push(runnerUsage.observe({ threadId: runnerTurn.threadId,
                segment: path.basename(runRoot), usage: runnerTurn.usage,
                eventId: `runner-${caseId}-${sequence}-${runnerUsageObservations.length + 1}` }));
            },
          }),
          });
        }
        mainTurnNumber = await startReservedTurn(runRoot, admission.main, turnLimit);
      } catch (error) {
        if (broker !== null) await broker.close();
        await releaseReservation(runRoot, admission.main, turnLimit);
        await releaseReservation(runRoot, runnerReservation, turnLimit);
        throw error;
      }
      const contextRole = ['REVIEW_PLAN', 'REVIEW_TASKS', 'VALIDATE_SLICE'].includes(operation) ? `review-${operation.toLowerCase()}` : 'author';
      const threadId = null;
      announce({ kind: 'start', status: 'STARTED', runId: path.basename(runRoot), caseId,
        operation, slice, model: route.label, effort: route.effort,
        mainTurns: caseState.mainTurns + 1, runnerTurns: caseState.runnerTurns,
        ...await budgetSnapshot(runRoot), artifacts: caseRoot });
      let turn;
      let lastProgressMs = 0;
      const heartbeat = setInterval(() => announce({ kind: 'progress', status: 'RUNNING',
        runId: path.basename(runRoot), caseId, operation, slice,
        durationMs: Date.now() - startedMs, model: route.label, effort: route.effort,
        mainTurns: caseState.mainTurns + 1, runnerTurns: caseState.runnerTurns,
        artifacts: caseRoot }), 60_000);
      try {
        const outputSchema = operation === 'SPEC_READINESS'
          ? await readJson(path.join(runRoot, 'snapshot', 'skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json'))
          : undefined;
        turn = await runTemplateTurn(product, { env: turnEnv, cwd: workspace, prompt,
          model: route.model, effort: route.effort, threadId, operationId, eventsPath,
          outputSchema, timeoutMs: RUNNER_OPERATIONS.has(operation) ? 1_800_000 : 900_000, signal,
          onEvent: (event) => {
            if (event.type !== 'item.started' && event.type !== 'item.completed') return;
            const itemType = event.item?.type;
            if (!['command_execution', 'file_change', 'collab_tool_call', 'mcp_tool_call'].includes(itemType)) return;
            if (Date.now() - lastProgressMs < 30_000) return;
            lastProgressMs = Date.now();
            announce({ kind: 'progress', status: 'RUNNING', runId: path.basename(runRoot), caseId,
              operation, slice, stage: itemType, durationMs: Date.now() - startedMs,
              model: route.label, effort: route.effort, artifacts: caseRoot });
          },
        });
        await settleTurn(runRoot, mainTurnNumber, turn, turnLimit);
      } catch (error) {
        await settleTurn(runRoot, mainTurnNumber, { turnStarted: false, threadId: null }, turnLimit);
        throw error;
      } finally {
        clearInterval(heartbeat);
        if (broker !== null) await broker.close();
        await releaseReservation(runRoot, runnerReservation, turnLimit);
      }
      if (turn.turnStarted !== false) caseState.mainTurns += 1;
      // Keep the last observed IDs for diagnostics, never for template resume.
      caseState.threads[contextRole] = turn.threadId;
      const mainUsageObservation = mainUsage.observe({ threadId: turn.threadId,
        segment: path.basename(runRoot), usage: turn.usage, eventId: operationId,
        parentThreadId: threadId });
      const collaborationEvents = await unmanagedCollaborationEvents(eventsPath, operationId, runnerEventPaths);
      providerConfigError ??= providerConfigurationError([], turn.providerError ?? turn.errorEvent ?? null);
      const allUsage = [mainUsageObservation, ...runnerUsageObservations,
        ...collaborationEvents.map((event) => ({ status: 'unavailable', delta: null,
          reason: 'unmanaged collaboration usage unknown', source: 'unmanaged_collaboration', event }))];
      const usageComplete = allUsage.every((observation) => ['attributable', 'duplicate'].includes(observation.status));
      const normalizedUsage = usageComplete ? {
        input_tokens: allUsage.reduce((sum, observation) => sum + observation.delta.input, 0),
        output_tokens: allUsage.reduce((sum, observation) => sum + observation.delta.output, 0),
        cached_input_tokens: allUsage.reduce((sum, observation) => sum + observation.delta.cachedInput, 0),
        cache_write_input_tokens: allUsage.reduce((sum, observation) => sum + observation.delta.cacheWrite, 0),
        reasoning_output_tokens: allUsage.reduce((sum, observation) => sum + observation.delta.reasoningOutput, 0),
      } : null;
      const readback = await officialReadback(product, specPath);
      let readinessResult = null;
      let readinessDiagnostic = null;
      if (operation === 'SPEC_READINESS' && turn.completed) {
        try {
          if (product.readinessSnapshot(specPath).snapshotSha256 !== beforeReadiness.snapshotSha256) {
            fail('READINESS mutated the evaluated workspace');
          }
          readinessResult = product.validateReadinessResult(specPath, JSON.parse(turn.response), { scope: 'GLOBAL' });
        } catch (error) { readinessDiagnostic = error.message; }
      }
      const outcome = providerConfigError
        ? { result: 'BLOCKED', blocker: providerConfigError.code, diagnostic: providerConfigError.message }
        : guardOperationProvenance(decideOutcome(operation, readback, turn.completed, readinessResult),
          operation, collaborationEvents, broker?.capturedReceipts ?? 0);
      if (broker?.errors.includes('PAUSED_BUDGET_OR_QUOTA')) {
        outcome.result = 'PAUSED_BUDGET_OR_QUOTA'; outcome.blocker = 'PAUSED_BUDGET_OR_QUOTA';
      }
      if (readinessDiagnostic && !providerConfigError) outcome.blocker = 'READINESS_RESULT_INVALID';
      if (operation === 'SPEC_RESUME' && outcome.result === 'PASS'
        && product.readinessSnapshot(specPath).snapshotSha256 === beforeResume.snapshotSha256) {
        outcome.result = 'BLOCKED'; outcome.blocker = 'RESUME_NO_MATERIAL_PROGRESS';
      }
      const runnerCount = caseState.runnerTurns - runnerTurnsBefore;
      const journalResult = outcome.result === 'PAUSED_BUDGET_OR_QUOTA'
        ? { exitCode: 0, stdout: 'administrative pause before a complete operation; journal unchanged', stderr: '' }
        : command(argsForJournal({ journal, operation, route, outcome, slice, readback, readinessResult,
          turn: { ...turn, usage: normalizedUsage, prompt }, durationMs: Date.now() - startedMs, runnerCount }));
      if (journalResult.exitCode !== 0) {
        if (!providerConfigError) outcome.result = 'BLOCKED', outcome.blocker = 'JOURNAL_REJECTED';
      }
      const evidence = { sequence, operation, slice, promptFile, templatePath, templateSha256: hash(template),
        promptSha256: hash(prompt), context: { role: contextRole, priorThreadId: threadId, threadId: turn.threadId,
          inheritedAuthorHistory: contextRole === 'author' && threadId !== null },
        dispatch: route, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
        turn: { completed: turn.completed, error: turn.error, requestedModel: turn.requestedModel,
          reportedModel: turn.reportedModel, requestedEffort: turn.requestedEffort, usage: turn.usage,
          toolCalls: turn.toolCalls, eventsPath, response: turn.response,
          turnStarted: turn.turnStarted, usageObservation: mainUsageObservation },
        officialPreflight, officialReadback: { lifecycle: readback.lifecycle, execution: readback.execution },
        readinessResult, readinessDiagnostic,
        providerConfigurationError: providerConfigError,
        runner: { requestsHandled: broker?.requestsHandled ?? 0, capturedReceipts: broker?.capturedReceipts ?? 0,
          errors: broker?.errors ?? [], transportFailed: runnerTransportFailed,
          turns: runnerCount, usageObservations: runnerUsageObservations,
          unmanagedCollaboration: collaborationEvents },
        normalizedUsage,
        journal: { exitCode: journalResult.exitCode, diagnostic: journalResult.stderr || journalResult.stdout }, outcome,
        recovery: currentRecovery };
      const evidencePath = path.join(caseRoot, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.json`);
      await atomicJson(evidencePath, evidence);
      caseState.operations.push({ operation, slice, outcome, evidencePath, threadId: turn.threadId,
        recovery: currentRecovery });
      await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
      announce({ runId: path.basename(runRoot), caseId, operation, slice, state: readback.execution?.state ?? readback.lifecycle?.status,
        result: outcome.result, durationMs: evidence.durationMs, model: route.label, effort: route.effort,
        mainTurns: caseState.mainTurns, runnerTurns: caseState.runnerTurns,
        ...await budgetSnapshot(runRoot), artifacts: caseRoot });
      terminal = outcome;
      if (outcome.result === 'BLOCKED') {
        const recovery = await prepareOfficialRecovery({ product, specPath, operation, slice, outcome, readback,
          priorOperations: caseState.operations, budgets: caseConfiguration.budgets,
          remainingTurns: (await budgetSnapshot(runRoot)).turnBudget.remaining,
          transportFailed: turn.completed !== true || turn.error != null || turn.processError != null
            || turn.errorEvent != null || runnerTransportFailed || (broker?.errors.length ?? 0) > 0 });
        if (recovery !== null) {
          pendingRecovery = recovery;
          target = { operation: recovery.operation, slice: recovery.slice };
          continue;
        }
      }
      if (['BLOCKED', 'FAIL', 'PAUSED_BUDGET_OR_QUOTA'].includes(outcome.result)) break;
      if (operation === 'SPEC_READINESS') pendingReadinessResult = readinessResult;
      target = nextHandoff(operation, { ...readback, product }, pendingReadinessResult);
      if (target === null && operation !== 'SPEC_CLOSE') { terminal = { result: 'BLOCKED', blocker: 'NO_OFFICIAL_HANDOFF' }; break; }
    }
  } catch (error) {
    terminal = error.code === 'PAUSED_BUDGET_OR_QUOTA'
      ? { result: 'PAUSED_BUDGET_OR_QUOTA', blocker: 'PAUSED_BUDGET_OR_QUOTA', diagnostic: error.message }
      : { result: 'BLOCKED', blocker: PROVIDER_CONFIGURATION_ERRORS.has(error.code) ? error.code : 'DRIVER_FAILURE',
        diagnostic: String(error.message) };
  } finally {
    let finalizer = null;
    const rawPath = path.join(caseRoot, resume ? `raw-resume-${caseState.operations.length}.json` : 'raw.json');
    if (await exists(specPath)) {
      finalizer = command(['finalize', '--workspace', workspace, '--case', caseId, '--spec', specPath,
        '--journal', journal, '--output', rawPath]);
    }
    const raw = await readJson(rawPath).catch(() => null);
    const status = terminal?.result === 'FOCAL_STOP' ? 'FOCAL_STOP'
      : terminal?.result === 'PAUSED_BUDGET_OR_QUOTA' ? 'PAUSED_BUDGET_OR_QUOTA'
      : terminal?.result === 'BLOCKED' || terminal?.result === 'FAIL' ? 'BLOCKED'
        : raw?.status ?? 'BLOCKED';
    caseState.status = status;
    caseState.terminal = terminal;
    if (resume && caseState.finalizer) {
      caseState.finalizerHistory = [...(caseState.finalizerHistory ?? []), caseState.finalizer];
    }
    caseState.finalizer = finalizer === null ? null : { exitCode: finalizer.exitCode,
      diagnostic: finalizer.stderr || finalizer.stdout, rawPath: await exists(rawPath) ? rawPath : null };
    caseState.endedAt = new Date().toISOString();
    try { await assertSnapshotIntegrity(runRoot); caseState.integrity = 'PASS'; }
    catch (error) { caseState.integrity = `BLOCKED: ${error.message}`; caseState.status = 'BLOCKED'; }
    if (home !== null) {
      try {
        if (caseState.status === 'FOCAL_STOP' || caseState.status === 'PAUSED_BUDGET_OR_QUOTA') {
          caseState.suspendedHome = await product.suspendIsolatedHome(home, { runId: path.basename(runRoot), caseId });
          caseState.privateHomeSuspended = true;
          caseState.privateHomeRemoved = false;
        } else {
          await product.removeIsolatedHome(home, { runId: path.basename(runRoot), caseId });
          caseState.privateHomeRemoved = true;
          caseState.privateHomeSuspended = false;
          caseState.suspendedHome = null;
        }
      } catch (error) {
        caseState.privateHomeRemoved = false;
        caseState.privateHomeCleanupError = error.message;
        caseState.status = 'BLOCKED';
      }
    }
    await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
  }
  return { caseId, status: caseState.status, terminal: caseState.terminal,
    operations: caseState.operations.length, mainTurns: caseState.mainTurns,
    runnerTurns: caseState.runnerTurns, rawPath: caseState.finalizer?.rawPath ?? null };
}

async function run(options) {
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
      : await createSnapshot(runRoot);
    if (options.resumeId) await assertSnapshotIntegrity(runRoot);
    const product = await loadProduct(path.join(runRoot, 'snapshot'));
    const previous = options.resumeId ? await readJson(path.join(runRoot, 'run.json')) : null;
    const mode = options.maxOperations !== null ? 'focal' : options.full ? 'full' : 'case';
    if (previous && (previous.status !== 'FOCAL_STOP' || previous.cases.length !== 1
      || previous.mode !== 'focal' || previous.profile !== 'production-v3')) {
      fail('only a stopped, single-case focal run can be resumed');
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
  const suspended = [];
  for (const name of await fs.readdir(root)) {
    if (name.startsWith('case-')) {
      const state = await readJson(path.join(root, name, 'case-state.json')).catch(() => null);
      if (!state || state.status === 'ACTIVE') fail('run contains an active or unclean case');
      if (state.privateHomeSuspended === true && state.suspendedHome) suspended.push(state);
      else if (state.privateHomeRemoved !== true) fail('run contains an active or unclean case');
    }
  }
  if (suspended.length > 0) {
    const product = await loadProduct(path.join(root, 'snapshot'));
    for (const state of suspended) {
      await product.removeIsolatedHome(state.suspendedHome, { runId: id, caseId: state.caseId });
    }
  }
  async function thaw(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await thaw(path.join(directory, entry.name));
    }
    await fs.chmod(directory, 0o700);
  }
  await thaw(root);
  await fs.rm(root, { recursive: true });
  announce({ runId: id, cleaned: true });
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
export async function main(argv) {
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
    return run({ caseId, full: !!values.full, resumeId, maxOperations });
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
