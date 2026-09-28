import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admitOperation, assertManagedSliceLauncher, budgetSnapshot, decideOutcome,
  initializeTurnBudget, nextHandoff, recoverableRunnerHandoff, settleTurn, startReservedTurn } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MANAGER = path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');

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
  for (const name of ['benchmark-manager.mjs', 'benchmark-snapshot.mjs', 'benchmark-ui.mjs']) {
    await fs.copyFile(path.join(ROOT, 'benchmarks/sentinel-todo/runtime', name), path.join(runtime, name));
  }
  const isolatedRuns = path.join(fixture, 'benchmark-temp');
  await assert.rejects(fs.lstat(isolatedRuns), { code: 'ENOENT' });
  const manager = await import(pathToFileURL(path.join(runtime, 'benchmark-manager.mjs')).href);
  assert.equal(await manager.main(['status', '--json']), 0);
  assert.equal((await fs.stat(isolatedRuns)).isDirectory(), true);
});
