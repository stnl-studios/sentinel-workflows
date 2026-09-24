#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertSnapshotIntegrity, createSnapshot } from './benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MARKER = 'sentinel-todo-run-v2\n';
const ACTIVE = path.join(RUNS, '.active-run.json');
const LEDGER = path.join(RUNS, '.turn-ledger.json');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'runtime', 'benchmark.mjs');
const MANIFEST = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'benchmark.json');
const PHASE = {
  SPEC_INIT: 'SPEC', SPEC_READINESS: 'REVIEW_VALIDATE', SPEC_CLOSE: 'SPEC',
  PLAN: 'PLAN', REPLAN: 'PLAN', REVIEW_PLAN: 'REVIEW_VALIDATE',
  MATERIALIZE_TASKS: 'TASKS', REVIEW_TASKS: 'REVIEW_VALIDATE',
  EXECUTE_SLICE: 'EXECUTE', APPLY_FINDINGS: 'EXECUTE', VALIDATE_SLICE: 'REVIEW_VALIDATE',
};
const TEMPLATE = {
  SPEC_INIT: 'spec-init.md', SPEC_READINESS: 'spec-readiness.md', SPEC_CLOSE: 'spec-close.md',
  PLAN: 'execution-plan.md', REPLAN: 'execution-replan.md', REVIEW_PLAN: 'execution-plan-review.md',
  MATERIALIZE_TASKS: 'execution-tasks.md', REVIEW_TASKS: 'execution-tasks-review.md',
  EXECUTE_SLICE: 'slice-execute-codex.md', APPLY_FINDINGS: 'slice-apply-findings-codex.md',
  VALIDATE_SLICE: 'slice-validate-codex.md',
};
const RUNNER_OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
const BLOCKED_STATES = new Set(['AUXILIARY_BLOCKED', 'DIVERGENCE_BLOCKED', 'REPLAN_REQUIRED',
  'REQUIREMENTS_CHANGED', 'RUNNER_INITIALIZATION_BLOCKED', 'RUNNER_RESULT_BLOCKED', 'VALIDATION_BLOCKED']);

function fail(message) { throw new Error(message); }
function hash(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function caseName(id) { return `case-${id.toLowerCase()}`; }
function announce(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
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
async function reserveTurn({ runId, caseId, role, operation }) {
  const job = ledgerWrite.then(async () => {
    let ledger;
    if (await exists(LEDGER)) ledger = await readJson(LEDGER);
    else ledger = { version: 1, limit: 100, priorS1Turns: 4, continuationProbeTurns: 6, total: 10, turns: [] };
    if (ledger.total >= ledger.limit) fail('global mission turn budget exhausted');
    ledger.total += 1;
    ledger.turns.push({ number: ledger.total, runId, caseId, role, operation, startedAt: new Date().toISOString() });
    await atomicJson(LEDGER, ledger);
    return ledger.total;
  });
  ledgerWrite = job.catch(() => {});
  return job;
}

export function renderLauncher(template, values) {
  const found = [...template.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]);
  if (new Set(found).size !== found.length) fail('launcher has duplicate parameter placeholders');
  for (const name of found) {
    const value = values[name];
    if (typeof value !== 'string' || value.trim() === '' || /[\r\n\0]/u.test(value)) fail(`launcher parameter ${name} is missing or malformed`);
  }
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/gu, (_whole, name) => values[name]);
  if (/\{\{[^}]+\}\}|__[^_\s]+__/u.test(rendered)) fail('launcher contains an unresolved placeholder');
  return rendered;
}

function dispatch(configuration, caseId, operation) {
  const phase = PHASE[operation];
  const target = configuration.productionProfile.cases[caseId][phase];
  if (!target) fail(`missing production-v2 dispatch for ${caseId}/${operation}`);
  return { phase, label: target.model, model: target.model.toLowerCase(), effort: target.effort };
}
function compactExecution(execution) {
  if (!execution) return null;
  if (execution.error) return { error: execution.error };
  return { state: execution.state, currentFingerprint: execution.currentFingerprint ?? null,
    legalOperations: execution.legalOperations ?? [], normalHandoff: execution.normalHandoff ?? null,
    requiredRecoveryHandoff: execution.requiredRecoveryHandoff ?? null,
    rows: execution.rows?.map((row) => ({ slice: row.slice, done: row.done, result: row.result })) ?? [] };
}
async function officialReadback(product, specPath) {
  if (!await exists(specPath)) return { lifecycle: { error: 'SPEC not created' }, execution: { error: 'SPEC not created' }, executionRaw: null };
  const lifecycle = await Promise.resolve().then(() => product.validateWorkspace(specPath)).catch((error) => ({ error: error.message }));
  const executionRaw = await product.inspectExecutionState(specPath).catch((error) => ({ error: error.message }));
  return { lifecycle: lifecycle.error ? lifecycle : { status: lifecycle.status, closed: lifecycle.closed },
    execution: compactExecution(executionRaw), executionRaw };
}
export function decideOutcome(operation, readback, completed) {
  const lifecycle = readback.lifecycle;
  const execution = readback.execution;
  if (!completed) return { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' };
  if (operation === 'SPEC_INIT') {
    return lifecycle?.status === 'ready' && execution?.state === 'EMPTY'
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_INIT_NOT_READY' };
  }
  if (operation === 'SPEC_READINESS') {
    return lifecycle?.status === 'ready' && ['EMPTY', 'COMPLETE'].includes(execution?.state)
      ? { result: 'PASS', blocker: null } : { result: 'BLOCKED', blocker: 'OFFICIAL_GLOBAL_READINESS_BLOCKED' };
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
    PLAN: ['PLANNED_DRAFT'], REVIEW_PLAN: ['PLANNED_READY'],
    MATERIALIZE_TASKS: ['MATERIALIZED_PRISTINE'], REVIEW_TASKS: ['MATERIALIZED_PRISTINE'],
    EXECUTE_SLICE: ['IMPLEMENTED_AWAITING_VALIDATION'], APPLY_FINDINGS: ['FINDINGS_CORRECTED'],
    VALIDATE_SLICE: ['EXECUTION_STARTED', 'COMPLETE'], REPLAN: ['PENDING_REPLAN_DRAFT'],
  };
  if (accepted[operation]?.includes(execution?.state)) return { result: 'PASS', blocker: null };
  if (['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(operation)
    && execution?.requiredRecoveryHandoff?.operation === 'VALIDATE_SLICE') return { result: 'PASS', blocker: null };
  return { result: 'BLOCKED', blocker: 'OFFICIAL_TRANSITION_NOT_OBSERVED' };
}
export function nextHandoff(operation, readback) {
  if (operation === 'SPEC_CLOSE') return null;
  if (operation === 'SPEC_INIT') return { operation: 'SPEC_READINESS', slice: null };
  if (readback.executionRaw?.state === 'COMPLETE') {
    return { operation: operation === 'SPEC_READINESS' ? 'SPEC_CLOSE' : 'SPEC_READINESS', slice: null };
  }
  const handoff = readback.executionRaw?.requiredRecoveryHandoff
    ?? readback.executionRaw?.normalHandoff
    ?? (readback.executionRaw ? readback.product?.deriveNormalHandoff?.(readback.executionRaw, operation) : null);
  return handoff?.operation ? { operation: handoff.operation, slice: handoff.slice ?? null } : null;
}
async function loadProduct(snapshot) {
  const execution = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-execution-planner/runtime/execution-state.mjs')).href);
  const lifecycle = await import(pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs')).href);
  const sdk = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/sdk-transport.mjs')).href);
  const home = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/isolated-home.mjs')).href);
  const runner = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/validation-runner.mjs')).href);
  const broker = await import(pathToFileURL(path.join(snapshot, 'agents/codex/runtime/runner-broker.mjs')).href);
  return { ...execution, validateWorkspace: lifecycle.validateWorkspace, ...sdk, ...home, ...runner, ...broker };
}
function argsForJournal({ journal, operation, route, outcome, slice, readback, turn, durationMs, runnerCount }) {
  const args = ['journal-event', '--journal', journal, '--operation', operation, '--phase', route.phase,
    '--model', route.label, '--effort', route.effort, '--result', outcome.result,
    '--duration-ms', String(durationMs), '--input-bytes', String(Buffer.byteLength(turn.prompt)),
    '--output-bytes', String(Buffer.byteLength(turn.response ?? ''))];
  if (slice) args.push('--slice', slice);
  const state = operation === 'SPEC_READINESS' && outcome.result === 'PASS' ? 'GLOBAL_READY'
    : operation === 'SPEC_CLOSE' ? null : readback.execution?.state;
  if (state) args.push('--resulting-state', state);
  if (Number.isSafeInteger(turn.usage?.input_tokens)) args.push('--input-tokens', String(turn.usage.input_tokens));
  if (Number.isSafeInteger(turn.usage?.output_tokens)) args.push('--output-tokens', String(turn.usage.output_tokens));
  if (runnerCount > 0) args.push('--child-role', 'stnl_validation_runner', '--child-model', 'GPT-5.6-Luna', '--child-effort', 'medium');
  return args;
}
function specInput(slice) { return slice === null ? null : BigInt(slice.slice('slice-'.length)).toString(10); }

async function runCase({ runRoot, caseId, configuration, snapshotMetadata, maxOperations, mode, product, signal, resume = false }) {
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
  let target = { operation: 'SPEC_INIT', slice: null };
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
    target = nextHandoff(last.operation, { ...current, product });
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
      await product.verifyIsolatedHome(home);
      const { operation, slice } = target;
      const route = dispatch(configuration, caseId, operation);
      let officialPreflight = null;
      if (!operation.startsWith('SPEC_')) {
        const preflight = await product.preflightExecutionOperation(specPath, operation, specInput(slice));
        if (RUNNER_OPERATIONS.has(operation)) {
          officialPreflight = { exitCode: 0, operation, slice, inputSlice: specInput(slice),
            specPath, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
            legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
        }
      }
      const templatePath = path.join(runRoot, 'snapshot', 'templates', 'prompts', TEMPLATE[operation]);
      const template = await fs.readFile(templatePath, 'utf8');
      const values = { SPEC_PATH: specPath, REQUIREMENTS_SOURCE: requirementsPath,
        READINESS_SCOPE: 'GLOBAL', READINESS_FOCUS: 'not-applicable',
        REPLAN_REASON: 'official execution readback requires replanning',
        SLICE: slice === null ? '' : specInput(slice) };
      const prompt = renderLauncher(template, values);
      const promptFile = path.join(prompts, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.md`);
      await fs.writeFile(promptFile, prompt, { flag: 'wx' });
      const operationId = `${caseId}-${String(sequence).padStart(2, '0')}-${operation}`;
      const eventsPath = path.join(caseRoot, 'events.jsonl');
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const runnerTurnsBefore = caseState.runnerTurns;
      let broker = null;
      if (officialPreflight !== null) {
        broker = await product.startOfficialRunnerBroker({ workspace, tmpdir, operation, sequence, slice,
          officialPreflight,
          invoke: (request) => product.invokeIndependentRunner({
            ...request, snapshot: path.join(runRoot, 'snapshot'), workspace, tmpdir, env: home.env,
            onBeforeTurn: async () => { await reserveTurn({ runId: path.basename(runRoot), caseId, role: 'runner', operation }); },
            onTurn: async ({ turn: runnerTurn }) => { caseState.runnerTurns += 1; caseState.lastRunnerThread = runnerTurn.threadId; },
          }),
        });
      }
      const contextRole = ['REVIEW_PLAN', 'REVIEW_TASKS', 'VALIDATE_SLICE'].includes(operation) ? `review-${operation.toLowerCase()}` : 'author';
      const threadId = caseState.threads[contextRole] ?? null;
      await reserveTurn({ runId: path.basename(runRoot), caseId, role: 'main', operation });
      let turn;
      try {
        turn = await product.runCodexTurn({ env: home.env, cwd: workspace, prompt,
          model: route.model, effort: route.effort, threadId, operationId, eventsPath,
          timeoutMs: RUNNER_OPERATIONS.has(operation) ? 1_800_000 : 900_000, signal,
        });
      } finally { if (broker !== null) await broker.close(); }
      caseState.mainTurns += 1;
      caseState.threads[contextRole] = turn.threadId;
      const readback = await officialReadback(product, specPath);
      const outcome = decideOutcome(operation, readback, turn.completed);
      const runnerCount = caseState.runnerTurns - runnerTurnsBefore;
      const journalResult = command(argsForJournal({ journal, operation, route, outcome, slice, readback,
        turn: { ...turn, prompt }, durationMs: Date.now() - startedMs, runnerCount }));
      if (journalResult.exitCode !== 0) outcome.result = 'BLOCKED', outcome.blocker = 'JOURNAL_REJECTED';
      const evidence = { sequence, operation, slice, promptFile, templatePath, templateSha256: hash(template),
        promptSha256: hash(prompt), context: { role: contextRole, priorThreadId: threadId, threadId: turn.threadId,
          inheritedAuthorHistory: contextRole === 'author' && threadId !== null },
        dispatch: route, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedMs,
        turn: { completed: turn.completed, error: turn.error, requestedModel: turn.requestedModel,
          reportedModel: turn.reportedModel, requestedEffort: turn.requestedEffort, usage: turn.usage,
          toolCalls: turn.toolCalls, eventsPath, response: turn.response },
        officialPreflight, officialReadback: { lifecycle: readback.lifecycle, execution: readback.execution },
        runner: { requestsHandled: broker?.requestsHandled ?? 0, errors: broker?.errors ?? [], turns: runnerCount },
        journal: { exitCode: journalResult.exitCode, diagnostic: journalResult.stderr || journalResult.stdout }, outcome };
      const evidencePath = path.join(caseRoot, `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.json`);
      await atomicJson(evidencePath, evidence);
      caseState.operations.push({ operation, slice, outcome, evidencePath, threadId: turn.threadId });
      await atomicJson(path.join(caseRoot, 'case-state.json'), caseState);
      announce({ runId: path.basename(runRoot), caseId, operation, slice, state: readback.execution?.state ?? readback.lifecycle?.status,
        result: outcome.result, durationMs: evidence.durationMs, model: route.label, effort: route.effort,
        mainTurns: caseState.mainTurns, runnerTurns: caseState.runnerTurns,
        globalTurns: (await readJson(LEDGER)).total, artifacts: caseRoot });
      terminal = outcome;
      if (outcome.result === 'BLOCKED' || outcome.result === 'FAIL') break;
      target = nextHandoff(operation, { ...readback, product });
      if (target === null && operation !== 'SPEC_CLOSE') { terminal = { result: 'BLOCKED', blocker: 'NO_OFFICIAL_HANDOFF' }; break; }
    }
  } catch (error) {
    terminal = { result: 'BLOCKED', blocker: 'DRIVER_FAILURE', diagnostic: String(error.message) };
  } finally {
    let finalizer = null;
    const rawPath = path.join(caseRoot, resume ? `raw-resume-${caseState.operations.length}.json` : 'raw.json');
    if (await exists(specPath)) {
      finalizer = command(['finalize', '--workspace', workspace, '--case', caseId, '--spec', specPath,
        '--journal', journal, '--output', rawPath]);
    }
    const raw = await readJson(rawPath).catch(() => null);
    const status = terminal?.result === 'FOCAL_STOP' ? 'FOCAL_STOP'
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
        if (caseState.status === 'FOCAL_STOP') {
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
    const snapshotMetadata = options.resumeId
      ? (await readJson(path.join(runRoot, 'run.json'))).snapshot
      : await createSnapshot(runRoot);
    if (options.resumeId) await assertSnapshotIntegrity(runRoot);
    const product = await loadProduct(path.join(runRoot, 'snapshot'));
    const previous = options.resumeId ? await readJson(path.join(runRoot, 'run.json')) : null;
    const mode = options.maxOperations !== null ? 'focal' : options.full ? 'full' : 'case';
    if (previous && (previous.status !== 'FOCAL_STOP' || previous.cases.length !== 1
      || previous.mode !== 'focal' || previous.profile !== 'production-v2')) {
      fail('only a stopped, single-case focal run can be resumed');
    }
    const caseId = previous?.cases[0] ?? options.caseId;
    const runInfo = previous
      ? { ...previous, status: 'ACTIVE', mode: options.maxOperations !== null ? 'focal' : 'case', resumedAt: new Date().toISOString() }
      : { runId: id, status: 'ACTIVE', mode, cases: options.full ? ['A', 'B', 'C'] : [caseId],
        snapshot: snapshotMetadata, startedAt: new Date().toISOString(), profile: 'production-v2' };
    await atomicJson(path.join(runRoot, 'run.json'), runInfo);
    announce({ runId: id, status: 'ACTIVE', mode, artifacts: runRoot, sourceFunctionalSha256: snapshotMetadata.sourceFunctionalSha256,
      globalTurns: (await readJson(LEDGER).catch(() => ({ total: 10 }))).total });
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
    summary = { runId: id, status: allPass ? 'PASS' : signalController.signal.aborted ? 'CANCELLED' : focalStop ? 'FOCAL_STOP' : 'BLOCKED',
      mode: runInfo.mode, cases: results, snapshotSha256: snapshotMetadata.snapshotSha256,
      sourceFunctionalSha256: snapshotMetadata.sourceFunctionalSha256,
      globalTurns: (await readJson(LEDGER)).total, endedAt: new Date().toISOString(), artifacts: runRoot };
    await atomicJson(path.join(runRoot, 'summary.json'), summary);
    await atomicJson(path.join(runRoot, 'run.json'), { ...runInfo, status: summary.status, endedAt: summary.endedAt });
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    await release(id);
  }
  announce(summary);
  return summary.status === 'PASS' || options.maxOperations !== null ? 0 : 1;
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
      artifacts: root });
    return 0;
  }
  const runs = [];
  for (const entry of await fs.readdir(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const root = await assertRun(entry.name).catch(() => null);
    if (!root) continue;
    runs.push({ runId: entry.name, summary: await readJson(path.join(root, 'summary.json')).catch(() => null) });
  }
  announce({ active: await readJson(ACTIVE).catch(() => null), globalTurns: (await readJson(LEDGER).catch(() => ({ total: 10 }))).total,
    runs: runs.sort((a, b) => b.runId.localeCompare(a.runId)) });
  return 0;
}
async function inspect(id, caseId) {
  const root = await assertRun(id);
  const selected = caseId ? [caseId] : ['A', 'B', 'C'];
  const cases = {};
  for (const name of selected) {
    const state = await readJson(path.join(root, caseName(name), 'case-state.json')).catch(() => null);
    if (state) cases[name] = { status: state.status, workspace: state.workspace,
      prompts: path.join(root, caseName(name), 'prompts'), events: path.join(root, caseName(name), 'events.jsonl'),
      tmp: path.join(root, caseName(name), 'tmp'), operations: state.operations,
      finalizer: state.finalizer, terminal: state.terminal };
  }
  announce({ runId: id, root, snapshot: path.join(root, 'snapshot'), cases });
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
    if (key === '--full') { if (values.full) fail('duplicate --full'); values.full = true; continue; }
    if (!new Set(['--case', '--run', '--resume', '--max-operations']).has(key) || values[key] !== undefined || !tokens[index + 1]) fail('invalid manager option');
    values[key] = tokens[++index];
  }
  return { verb, values };
}
export async function main(argv) {
  const { verb, values } = parse(argv);
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
