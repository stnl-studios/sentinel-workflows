import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admitOperation, assertManagedSliceLauncher, budgetSnapshot, decideOutcome, guardOperationProvenance, unmanagedCollaborationEvents,
  providerConfigurationError,
  initializeTurnBudget, nextHandoff, recoverableRunnerHandoff, settleTurn, startReservedTurn } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import * as manager from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MANAGER = path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');
const RECOVERY_BUDGETS = JSON.parse(await fs.readFile(path.join(ROOT,
  'benchmarks/sentinel-todo/benchmark.json'), 'utf8')).cases.find((item) => item.id === 'A').budgets;

function officialRecoveryInput() {
  const execution = { state: 'DIVERGENCE_BLOCKED', currentFingerprint: 'authority',
    recoveryTargets: [{ operation: 'REPLAN', slice: null, owner: 'active-divergence', record: 'divergence-01' }],
    legalOperations: [{ operation: 'REPLAN', slice: null }] };
  return { operation: 'EXECUTE_SLICE', slice: 'slice-01',
    outcome: decideOutcome('EXECUTE_SLICE', { execution }, true),
    readback: { execution, executionRaw: execution }, priorOperations: [],
    remainingTurns: 1, budgets: RECOVERY_BUDGETS };
}

test('official recovery requires one explicit legal target and keeps existing budgets and history', () => {
  assert.equal(typeof manager.recoverableOfficialHandoff, 'function');
  const input = officialRecoveryInput();
  const before = JSON.stringify(input);
  const recovery = manager.recoverableOfficialHandoff(input);
  assert.deepEqual(recovery, { operation: 'REPLAN', slice: null, state: 'DIVERGENCE_BLOCKED',
    authority: 'authority', target: input.readback.executionRaw.recoveryTargets[0] });
  for (const override of [
    { remainingTurns: 0 }, { remainingTurns: null }, { transportFailed: true },
    { outcome: { result: 'PASS', blocker: null } },
    ...['SDK_TURN_FAILED', 'SANDBOX_COMMAND_DENIED', 'JOURNAL_REJECTED',
      'UNMANAGED_COLLABORATION', 'invalid_json_schema'].map((blocker) => ({ outcome: { result: 'BLOCKED', blocker } })),
    { priorOperations: [{ operation: 'REPLAN', outcome: { result: 'PASS' } }] },
    { priorOperations: Array.from({ length: RECOVERY_BUDGETS.maxWorkflowEvents }, () => ({ operation: 'PLAN' })) },
  ]) assert.equal(manager.recoverableOfficialHandoff({ ...input, ...override }), null);
  for (const change of [
    { recoveryTargets: [] }, { legalOperations: [] }, { currentFingerprint: null },
    { recoveryTargets: [{ operation: null, slice: 'slice-01', owner: 'lifecycle', authorityMode: 'RESUME' }] },
    { recoveryTargets: [...input.readback.executionRaw.recoveryTargets,
      { operation: 'VALIDATE_SLICE', slice: 'slice-01' }] },
    { state: 'COMPLETE' }, { error: 'permission denied' },
    { state: 'VALIDATION_BLOCKED', recoveryTargets: [
      { operation: 'VALIDATE_SLICE', slice: 'slice-01', owner: 'validation-attempt' },
      { operation: 'REPLAN', slice: null, owner: 'execution-history' }] },
    { state: 'AUXILIARY_BLOCKED', recoveryTargets: [
      { operation: 'EXECUTE_SLICE', slice: 'slice-01', owner: 'auxiliary-check', sameOperationResumeRequired: true }],
      legalOperations: [{ operation: 'EXECUTE_SLICE', slice: 'slice-01' }] },
  ]) {
    const execution = { ...input.readback.executionRaw, ...change };
    assert.equal(manager.recoverableOfficialHandoff({ ...input,
      outcome: decideOutcome(input.operation, { execution }, true),
      readback: { execution, executionRaw: execution } }), null);
  }
  assert.equal(JSON.stringify(input), before, 'recovery selection cannot rewrite the failed operation or authority');
});

test('official recovery rereads authority and preflights without extra calls for normal or ineligible outcomes', async () => {
  assert.equal(typeof manager.prepareOfficialRecovery, 'function');
  const input = officialRecoveryInput();
  const calls = [];
  let execution = input.readback.executionRaw;
  let preflightResult = execution;
  const product = {
    validateWorkspace: () => ({ status: 'ready', closed: false }),
    inspectExecutionState: async () => { calls.push('readback'); return execution; },
    preflightExecutionOperation: async (spec, operation, slice) => {
      calls.push({ spec, operation, slice }); return preflightResult;
    },
  };
  for (const override of [{ outcome: { result: 'PASS', blocker: null } },
    { remainingTurns: 0 }, { transportFailed: true }]) {
    assert.equal(await manager.prepareOfficialRecovery({ ...input, ...override, product, specPath: ROOT }), null);
  }
  assert.deepEqual(calls, [], 'no extra readback or preflight is needed without recovery');
  assert.deepEqual(await manager.prepareOfficialRecovery({ ...input, product, specPath: ROOT }),
    manager.recoverableOfficialHandoff(input));
  assert.deepEqual(calls.splice(0), ['readback', { spec: ROOT, operation: 'REPLAN', slice: null }]);
  for (const change of [ { currentFingerprint: 'changed-authority' }, { legalOperations: [] },
    { recoveryTargets: [{ ...execution.recoveryTargets[0], record: 'divergence-02' }] },
    { recoveryTargets: [...execution.recoveryTargets, { operation: 'VALIDATE_SLICE', slice: 'slice-01' }] } ]) {
    execution = { ...input.readback.executionRaw, ...change };
    assert.equal(await manager.prepareOfficialRecovery({ ...input, product, specPath: ROOT }), null);
    assert.deepEqual(calls.splice(0), ['readback'], 'stale recovery must stop before preflight');
  }
  execution = input.readback.executionRaw;
  preflightResult = { ...execution, currentFingerprint: 'changed-during-preflight' };
  assert.equal(await manager.prepareOfficialRecovery({ ...input, product, specPath: ROOT }), null);
  calls.splice(0);
  product.preflightExecutionOperation = async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
  await assert.rejects(manager.prepareOfficialRecovery({ ...input, product, specPath: ROOT }), { code: 'EACCES' });
});

test('unmanaged collaboration and absent official receipt cannot yield a valid operation sample', () => {
  const pass = { result: 'PASS', blocker: null };
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
    assert.deepEqual(guardOperationProvenance(pass, operation, [], 0),
      { result: 'BLOCKED', blocker: 'OFFICIAL_RUNNER_RECEIPT_MISSING' });
    assert.deepEqual(guardOperationProvenance(pass, operation, [{ source: 'main', tool: 'spawn_agent' }], 1),
      { result: 'BLOCKED', blocker: 'UNMANAGED_COLLABORATION' });
    assert.deepEqual(guardOperationProvenance(pass, operation, [], 1), pass);
  }
  assert.deepEqual(guardOperationProvenance({ result: 'NEEDS_FIX', blocker: null }, 'VALIDATE_SLICE', [], 0),
    { result: 'BLOCKED', blocker: 'OFFICIAL_RUNNER_RECEIPT_MISSING' });
  assert.deepEqual(guardOperationProvenance(pass, 'PLAN', [{ source: 'main', tool: 'spawn_agent' }], 0),
    { result: 'BLOCKED', blocker: 'UNMANAGED_COLLABORATION' });
});

test('historical Case C collaboration events remain detectable as unmeasured delegation', async (t) => {
  const file = path.join(ROOT, 'benchmark-temp/run-20260929125208-f85c2e3a/case-c/events.jsonl');
  if (!await fs.access(file).then(() => true, () => false)) { t.skip('historical local replay artifact is absent'); return; }
  const events = await unmanagedCollaborationEvents(file, 'C-08-VALIDATE_SLICE');
  assert.ok(events.some((event) => event.source === 'main' && event.tool === 'spawn_agent'));
  assert.deepEqual(guardOperationProvenance({ result: 'PASS', blocker: null }, 'VALIDATE_SLICE', events, 0),
    { result: 'BLOCKED', blocker: 'UNMANAGED_COLLABORATION' });
});

test('managed launcher disagreement stops before SDK and runner dispatch for every runner operation', () => {
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
    const context = { operation, slice: 'slice-01', specPath: '/run-ABC123/case-c/workspace/specs/case-c' };
    const prompt = `Use runner.\nOPERATION=${operation}\nSPEC_PATH=${context.specPath}\nSLICE=1\n`;
    assert.doesNotThrow(() => assertManagedSliceLauncher(prompt, context, '1'));
    assert.throws(() => assertManagedSliceLauncher(prompt.replace('/run-ABC123/', '/run-ABC123-c-QwE456/'), context, '1'),
    /managed launcher SPEC_PATH disagrees/u);
    assert.throws(() => assertManagedSliceLauncher(prompt.replace('SLICE=1', 'SLICE=2'), context, '1'),
    /managed launcher SLICE disagrees/u);
    const wrongOperation = operation === 'EXECUTE_SLICE' ? 'VALIDATE_SLICE' : 'EXECUTE_SLICE';
    assert.throws(() => assertManagedSliceLauncher(prompt.replace(`OPERATION=${operation}`, `OPERATION=${wrongOperation}`), context, '1'),
    /managed launcher OPERATION disagrees/u);
  }
});

function invoke(...args) {
  return spawnSync(process.execPath, [MANAGER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function ownedRun(t) {
  const id = `run-test-${randomUUID()}`;
  const root = path.join(RUNS, id);
  await fs.mkdir(root, { recursive: true });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ status: 'PASS', cases: { A: { status: 'PASS' } } }));
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ status: 'PASS', mode: 'case', snapshot: {
    snapshotSha256: 'snapshot', sourceFunctionalSha256: 'source',
  } }));
  return { id, root };
}

test('INIT ready advances directly and COMPLETE closes without terminal readiness', () => {
  const readback = { lifecycle: { status: 'ready' }, execution: { state: 'COMPLETE' },
    executionRaw: { state: 'COMPLETE' } };
  assert.deepEqual(nextHandoff('VALIDATE_SLICE', readback), { operation: 'SPEC_CLOSE', slice: null });
  assert.equal(nextHandoff('SPEC_CLOSE', readback), null);
  const initial = {
    lifecycle: { status: 'ready' }, execution: { state: 'EMPTY' }, executionRaw: { state: 'EMPTY' },
  };
  assert.deepEqual(decideOutcome('SPEC_INIT', initial, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_INIT', initial), { operation: 'PLAN', slice: null });
});

test('manager dispatches only the legal, bounded runner-result recovery', () => {
  const execution = { state: 'RUNNER_RESULT_BLOCKED', currentFingerprint: 'authority',
    activeDelegationBlockers: [{ operation: 'VALIDATE_SLICE', slice: 'slice-02', kind: 'malformed-output' }],
    mandatoryRecovery: { owner: 'delegation-blocker', operation: 'VALIDATE_SLICE',
      slice: 'slice-02', sameOperationResumeRequired: true },
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-02' }] };
  const readback = { execution, executionRaw: execution };
  const outcome = decideOutcome('VALIDATE_SLICE', readback, true);
  assert.deepEqual(outcome, { result: 'BLOCKED', blocker: 'OFFICIAL_RUNNER_RESULT_BLOCKED' });
  assert.deepEqual(nextHandoff('VALIDATE_SLICE', readback), { operation: 'VALIDATE_SLICE', slice: 'slice-02' });
  const input = { operation: 'VALIDATE_SLICE', slice: 'slice-02', outcome, readback,
    priorOperations: [], remainingTurns: 2 };
  assert.equal(recoverableRunnerHandoff(input)?.authority, 'authority');
  assert.equal(recoverableRunnerHandoff({ ...input, remainingTurns: 1 }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, priorOperations: [{ recovery: {
    operation: 'VALIDATE_SLICE', slice: 'slice-02' } }] }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, readback: { ...readback,
    executionRaw: { ...execution, legalOperations: [] } } }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, readback: { ...readback,
    executionRaw: { ...execution, mandatoryRecovery: null } } }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, readback: { ...readback,
    executionRaw: { ...execution, activeDelegationBlockers: [{ ...execution.activeDelegationBlockers[0], kind: 'initialization' }] } } }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, outcome: { result: 'BLOCKED', blocker: 'OFFICIAL_REQUIREMENTS_CHANGED' } }), null);
  assert.equal(recoverableRunnerHandoff({ ...input, outcome: { result: 'BLOCKED', blocker: 'invalid_json_schema' } }), null);
  assert.equal(recoverableRunnerHandoff(input)?.operation, 'VALIDATE_SLICE');
  execution.recoveryTargets = [{ ...execution.mandatoryRecovery }];
  const officialInput = { ...input, budgets: RECOVERY_BUDGETS };
  assert.deepEqual(manager.recoverableOfficialHandoff(officialInput), {
    operation: 'VALIDATE_SLICE', slice: 'slice-02', state: execution.state,
    authority: execution.currentFingerprint, target: execution.recoveryTargets[0],
  });
  assert.equal(manager.recoverableOfficialHandoff({ ...officialInput, transportFailed: true }), null);
  assert.equal(manager.recoverableOfficialHandoff({ ...officialInput, remainingTurns: 1 }), null);
  assert.equal(manager.recoverableOfficialHandoff({ ...officialInput,
    priorOperations: [{ recovery: { operation: 'VALIDATE_SLICE', slice: 'slice-02' } }] }), null);
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    const resumed = { ...execution, activeDelegationBlockers: [{ operation, slice: 'slice-02', kind: 'malformed-output' }],
      mandatoryRecovery: { ...execution.mandatoryRecovery, operation },
      recoveryTargets: [{ ...execution.recoveryTargets[0], operation }], legalOperations: [{ operation, slice: 'slice-02' }] };
    const limit = RECOVERY_BUDGETS[operation === 'EXECUTE_SLICE'
      ? 'maxExecuteSliceAttemptsPerSlice' : 'maxApplyFindingsPerSlice'];
    const scopedInput = { ...officialInput, operation, readback: { execution: resumed, executionRaw: resumed } };
    assert.ok(manager.recoverableOfficialHandoff({ ...scopedInput,
      priorOperations: Array.from({ length: limit - 1 }, () => ({ operation, slice: 'slice-02' })) }));
    assert.equal(manager.recoverableOfficialHandoff({ ...scopedInput,
      priorOperations: Array.from({ length: limit }, () => ({ operation, slice: 'slice-02' })) }), null);
  }
});

test('deterministic provider schema rejection is preserved as a terminal cause', async () => {
  const cause = providerConfigurationError([{ type: 'error', code: 'invalid_json_schema', message: 'additionalProperties rejected' }]);
  assert.deepEqual(cause, { code: 'invalid_json_schema', message: 'additionalProperties rejected' });
  assert.equal(providerConfigurationError([{ type: 'error', code: 'rate_limit', message: 'retry later' }]), null);
  assert.equal(providerConfigurationError([], { code: 'invalid_configuration', message: 'unsupported schema' }).code,
    'invalid_configuration');
  assert.equal(providerConfigurationError([{ type: 'error', message: 'provider rejected: invalid_json_schema' }]).code,
    'invalid_json_schema');
  assert.deepEqual(providerConfigurationError([{ type: 'turn.failed', error: {
    code: 'invalid_json_schema', message: 'invalid_json_schema rejected',
  } }]), { code: 'invalid_json_schema', message: 'invalid_json_schema rejected' });
});

test('isolated-home verification happens once after preparation or resume, before operations', async () => {
  const source = await fs.readFile(MANAGER, 'utf8');
  assert.equal([...source.matchAll(/product\.verifyIsolatedHome\(home\)/gu)].length, 1);
  assert.match(source, /const auth = await product\.verifyIsolatedHome\(home\);[\s\S]*?for \(let sequence/u);
  assert.match(source, /providerConfigurationError\(\[\], runnerTurn\.providerError \?\? runnerTurn\.errorEvent/u);
  assert.match(source, /readinessDiagnostic && !providerConfigError/u);
  assert.match(source, /if \(!providerConfigError\) outcome\.result = 'BLOCKED', outcome\.blocker = 'JOURNAL_REJECTED'/u);
});

test('documentary maturation advances through global findings, RESUME, and status-only promotion', () => {
  const draft = { lifecycle: { status: 'draft' }, execution: { state: 'EMPTY' }, executionRaw: { state: 'EMPTY' } };
  const findings = { verdict: 'FINDINGS', findings: [{ action: 'REFINE_FROM_EVIDENCE' }] };
  const ready = { verdict: 'READY', findings: [] };
  assert.deepEqual(decideOutcome('SPEC_INIT', draft, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_INIT', draft), { operation: 'SPEC_READINESS', slice: null });
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, findings), { result: 'NEEDS_FIX', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_READINESS', draft, findings), { operation: 'SPEC_RESUME', slice: null });
  assert.deepEqual(nextHandoff('SPEC_RESUME', draft), { operation: 'SPEC_READINESS', slice: null });
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, ready), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_READINESS', draft, ready), { operation: 'SPEC_PROMOTE', slice: null });
  assert.deepEqual(nextHandoff('SPEC_PROMOTE', { ...draft, lifecycle: { status: 'ready' } }), { operation: 'PLAN', slice: null });
  const decision = { verdict: 'FINDINGS', findings: [{ action: 'DECISION_REQUIRED' }] };
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, decision), { result: 'BLOCKED', blocker: 'BLOCKED_REQUIRED_DECISION' });
});

test('READINESS output schema gives every field a provider-valid type', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT,
    'skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json'), 'utf8'));
  function check(node) {
    assert.ok(node.type, 'each generated field needs an explicit type');
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      for (const property of Object.values(node.properties)) check(property);
    }
    if (node.type === 'array') check(node.items);
  }
  check(schema);
});

test('status and inspect are read only and clean removes only the selected owned run', async (t) => {
  const { id, root } = await ownedRun(t);
  const other = await ownedRun(t);
  const caseRoot = path.join(root, 'case-a');
  await fs.mkdir(caseRoot);
  await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({
    status: 'PASS', privateHomeRemoved: true, operations: [], terminal: { result: 'PASS' },
  }));
  const status = invoke('status', '--run', id, '--json');
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).status, 'PASS');
  const inspected = invoke('inspect', '--run', id, '--case', 'A', '--json');
  assert.equal(inspected.status, 0);
  assert.equal(JSON.parse(inspected.stdout).cases.A.status, 'PASS');
  assert.equal((await fs.readdir(root)).includes('summary.json'), true);
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  assert.equal((await fs.lstat(other.root)).isDirectory(), true);
});

test('clean refuses a symlink in an owned run and leaves evidence intact', async (t) => {
  const { id, root } = await ownedRun(t);
  await fs.symlink(path.join(ROOT, 'README.md'), path.join(root, 'escape'));
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /contains a symlink/u);
  assert.equal((await fs.lstat(path.join(root, 'summary.json'))).isFile(), true);
});

test('clean accepts recorded zero-turn failure before private home creation', async (t) => {
  const { id, root } = await ownedRun(t);
  const dir = path.join(root, 'case-a');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'case-state.json'), JSON.stringify({ caseId: 'A', status: 'BLOCKED',
    privateHomeNotCreated: true, operations: [], mainTurns: 0, runnerTurns: 0, finalizer: null }));
  await fs.writeFile(path.join(dir, 'journal.json'), JSON.stringify({ events: [] }));
  const result = invoke('clean', '--run', id);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
});

test('startup persists an uncreated home only for a recorded allocation failure', async (t) => {
  const { id, root } = await ownedRun(t);
  const configuration = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmarks/sentinel-todo/benchmark.json'), 'utf8'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const error = Object.assign(new Error('fixture allocation failure'), { code: 'EPERM', privateHomeNotCreated: true });
  const product = { ZERO_USAGE: {}, createUsageNormalizer: () => ({ observe: () => ({}) }),
    prepareIsolatedHome: async () => { throw error; } };
  const result = await manager.runCase({ runRoot: root, caseId: 'A', configuration, snapshotMetadata: { baseSha: head },
    maxOperations: null, mode: 'case', product, signal: new AbortController().signal });
  assert.equal(result.status, 'BLOCKED');
  const state = JSON.parse(await fs.readFile(path.join(root, 'case-a/case-state.json'), 'utf8'));
  const journal = JSON.parse(await fs.readFile(path.join(root, 'case-a/journal.json'), 'utf8'));
  assert.equal(state.terminal.blocker, 'DRIVER_FAILURE');
  assert.equal(manager.privateHomeNeverCreated(state, journal), true);
  for (const change of [{ privateHomeNotCreated: undefined }, { mainTurns: 1 }, { runnerTurns: 1 },
    { operations: [{}] }, { finalizer: {} }, { isolationHomePath: '/fixture/home' }, { suspendedHome: {} },
    { privateHomeCleanupError: 'failed' }, { status: 'ACTIVE' }]) {
    assert.equal(manager.privateHomeNeverCreated({ ...state, ...change }, journal), false);
  }
  assert.equal(manager.privateHomeNeverCreated(state, { events: [{}] }), false);
  assert.equal(manager.privateHomeNeverCreated(state, null), false);
});

test('fresh per-run budget starts at zero and safely admits concurrent B/C turns within its bound', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'sentinel-budget-'));
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));
  const root = path.join(tempRoot, 'run-test-budget');
  await fs.mkdir(root);
  await fs.writeFile(path.join(tempRoot, '.turn-ledger.json'), JSON.stringify({
    version: 1, limit: 100, priorS1Turns: 4, continuationProbeTurns: 6, total: 10, turns: [],
  }));
  assert.deepEqual((await budgetSnapshot(root)).turnBudget,
    { limit: null, consumed: null, remaining: null, mainTurns: null, runnerTurns: null });
  await initializeTurnBudget(root, 4);
  assert.deepEqual((await budgetSnapshot(root)).turnBudget,
    { limit: 4, consumed: 0, remaining: 4, mainTurns: 0, runnerTurns: 0 });

  const admissions = await Promise.all(['B', 'C'].map((caseId) => admitOperation({
    runRoot: root, runId: 'run-test-budget', caseId, operation: 'EXECUTE_SLICE',
    runnerRequired: true, limit: 4,
  })));
  await assert.rejects(admitOperation({ runRoot: root, runId: 'run-test-budget', caseId: 'C',
    operation: 'VALIDATE_SLICE', runnerRequired: false, limit: 4 }),
  (error) => error.code === 'PAUSED_BUDGET_OR_QUOTA');

  for (const admission of admissions) {
    for (const reservation of [admission.main, admission.runner]) {
      const number = await startReservedTurn(root, reservation, 4);
      await settleTurn(root, number, { completed: true, turnStarted: true, threadId: `thread-${number}` }, 4);
    }
  }
  assert.deepEqual((await budgetSnapshot(root)).turnBudget,
    { limit: 4, consumed: 4, remaining: 0, mainTurns: 2, runnerTurns: 2 });
  await fs.rm(path.join(root, '.turn-ledger.json'));
  await assert.rejects(admitOperation({ runRoot: root, runId: 'run-test-budget', caseId: 'A',
    operation: 'PLAN', runnerRequired: false, limit: 4 }),
  /run turn budget ledger is missing/u);
  await assert.rejects(fs.lstat(path.join(root, '.turn-ledger.json')), { code: 'ENOENT' });
});

test('manager status creates an absent benchmark-temp in an isolated checkout fixture', async (t) => {
  const fixture = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'sentinel-manager-fixture-'));
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }));
  const runtime = path.join(fixture, 'benchmarks/sentinel-todo/runtime');
  await fs.mkdir(runtime, { recursive: true });
  for (const name of ['benchmark-manager.mjs', 'benchmark-snapshot.mjs', 'benchmark-ui.mjs',
    'benchmark.mjs', 'benchmark-environment.mjs', 'product-acceptance.mjs', 'validation-reassessment.mjs', 'capacity-retry.mjs']) {
    await fs.copyFile(path.join(ROOT, 'benchmarks/sentinel-todo/runtime', name), path.join(runtime, name));
  }
  const isolatedRuns = path.join(fixture, 'benchmark-temp');
  await assert.rejects(fs.lstat(isolatedRuns), { code: 'ENOENT' });
  const manager = await import(pathToFileURL(path.join(runtime, 'benchmark-manager.mjs')).href);
  assert.equal(await manager.main(['status', '--json']), 0);
  assert.equal((await fs.stat(isolatedRuns)).isDirectory(), true);
});

test('T21/T22: B/C competing for the last admission and contradictory no-start settlement conserve budget', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'sentinel-last-admission-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeTurnBudget(root, 2);
  const results = await Promise.allSettled(['B', 'C'].map((caseId) => admitOperation({ runRoot: root,
    runId: 'run-last-admission', caseId, operation: 'EXECUTE_SLICE', runnerRequired: true, limit: 2 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'PAUSED_BUDGET_OR_QUOTA');
  const admission = results.find((r) => r.status === 'fulfilled').value;
  const main = await startReservedTurn(root, admission.main, 2), runner = await startReservedTurn(root, admission.runner, 2);
  await manager.settleTurn(root, runner, { completed: false, turnStarted: false, threadId: 'proof-of-start' }, 2);
  await manager.settleTurn(root, main, { completed: false, turnStarted: null, threadId: null }, 2);
  assert.deepEqual((await budgetSnapshot(root)).turnBudget, { limit: 2, consumed: 2, remaining: 0, mainTurns: 1, runnerTurns: 1 });
  await assert.rejects(manager.settleTurn(root, runner, { turnStarted: false }, 2), /settlement is invalid/u);
  assert.equal((await budgetSnapshot(root)).turnBudget.consumed, 2);
});
