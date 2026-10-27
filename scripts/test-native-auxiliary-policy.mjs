import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { reservedOperation } from './fixtures/current-native-operation.mjs';
import { bindNative } from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import { loadProduct } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { observeFormalRunner, validateNativeLedger } from '../benchmarks/sentinel-todo/runtime/native-evidence.mjs';

const product = await loadProduct(path.resolve(import.meta.dirname, '..'));
for (const [closed, sibling] of [['B', 'C'], ['C', 'B']])
test(`case ${closed} can finalize while sibling ${sibling} still owns admitted work`, () => {
  const ledger = { version: 1, limit: 48, total: 3,
    reservations: [{ id: 'sibling-reservation', runId: 'run', caseId: sibling, role: 'runner' }],
    turns: [
      { number: 1, runId: 'run', caseId: closed, role: 'main', state: 'completed' },
      { number: 2, runId: 'run', caseId: closed, role: 'runner', childKind: 'formal', state: 'completed' },
      { number: 3, runId: 'run', caseId: sibling, role: 'main', state: 'dispatched' },
    ] };
  const state = { caseId: closed, mainTurns: 1, runnerTurns: 1 };
  const unchanged = JSON.stringify(ledger);
  assert.equal(validateNativeLedger(ledger, state, 'run', { settled: true }), ledger);
  assert.equal(validateNativeLedger(ledger, state, 'run', { settled: true }), ledger);
  assert.equal(JSON.stringify(ledger), unchanged, 'validation does not settle or refund the sibling');
  for (const pendingState of ['dispatched', 'uncertain', 'failed']) {
    const ownPending = structuredClone(ledger); ownPending.turns[0].state = pendingState;
    assert.throws(() => validateNativeLedger(ownPending, state, 'run', { settled: true }));
  }
  const ownReservation = structuredClone(ledger); ownReservation.reservations[0].caseId = closed;
  assert.throws(() => validateNativeLedger(ownReservation, state, 'run', { settled: true }));
  const ownClassification = structuredClone(ledger); ownClassification.turns[1].childKind = 'pending';
  assert.throws(() => validateNativeLedger(ownClassification, state, 'run', { settled: true }));
});

test('sibling activity cannot hide invalid ledger identity or global auxiliary cost', () => {
  const base = { version: 1, limit: 48, total: 2,
    reservations: [{ id: 'sibling-reservation', runId: 'run', caseId: 'B', role: 'runner' }],
    turns: [
      { number: 1, runId: 'run', caseId: 'C', role: 'main', state: 'completed' },
      { number: 2, runId: 'run', caseId: 'B', role: 'main', state: 'dispatched' },
    ] };
  const state = { caseId: 'C', mainTurns: 1, runnerTurns: 0 };
  assert.throws(() => validateNativeLedger(base, { caseId: 'unknown', mainTurns: 0, runnerTurns: 0 }, 'run', { settled: true }));
  for (const mutation of [
    x => { delete x.turns[1].caseId; }, x => { x.turns[1].caseId = 'unknown'; },
    x => { x.turns[1].runId = 'different'; }, x => { delete x.reservations[0].caseId; },
    x => { x.reservations[0].caseId = 'unknown'; }, x => { x.reservations[0].runId = 'different'; },
    x => { x.total = 1; }, x => { x.turns[1].number = 1; },
    x => { x.limit = x.total; },
    x => {
      for (let number = 3; number < 12; number++) x.turns.push({ number, runId: 'run', caseId: 'B',
        role: 'runner', childKind: 'auxiliary', state: 'completed' });
      x.total = x.turns.length;
    },
  ]) {
    const ledger = structuredClone(base); mutation(ledger);
    assert.throws(() => validateNativeLedger(ledger, state, 'run', { settled: true }));
  }
});

test('historical child cost stays readable; optional auxiliary metadata cannot turn cost into formal proof', () => {
  const ledger = { version: 1, limit: 30, total: 2, reservations: [], turns: [
    { number: 1, runId: 'run', caseId: 'A', role: 'main', state: 'completed' },
    { number: 2, runId: 'run', caseId: 'A', role: 'runner', state: 'completed' },
  ] };
  const state = { caseId: 'A', mainTurns: 1, runnerTurns: 1 };
  assert.equal(validateNativeLedger(ledger, state, 'run', { settled: true }), ledger);
  ledger.turns[1].childKind = 'auxiliary';
  assert.equal(validateNativeLedger(ledger, state, 'run', { settled: true }), ledger);
  ledger.turns[1].childKind = 'pending';
  assert.throws(() => validateNativeLedger(ledger, state, 'run', { settled: true }));
  ledger.turns[1].childKind = 'formal-by-name';
  assert.throws(() => validateNativeLedger(ledger, state, 'run'));
});
test('formal designation requires the product binding, not a reservation or child label', async t => {
  const f = await reservedOperation(t);
  const input = { product, specPath: f.specPath, operation: 'VALIDATE_SLICE', slice: f.delivery.slice };
  assert.deepEqual(await observeFormalRunner(input), { state: 'pending' });
  await bindNative(f.start.handle, '/root/arbitrary-name');
  const designation = await observeFormalRunner(input);
  assert.equal(designation.agentPath, '/root/arbitrary-name');
  assert.equal(designation.operationAttemptId, f.start.owner.operationAttemptId);
  assert.equal(designation.dispatchId, f.dispatch.dispatchId);
  assert.equal(designation.round, 1);
  await assert.rejects(observeFormalRunner({ ...input, operation: 'EXECUTE_SLICE' }));
  assert.equal(await observeFormalRunner({ ...input, operation: 'PLAN' }), null);
});
test('pending formal observation requires an intact official unbound reservation', async t => {
  const f = await reservedOperation(t), input = { product, specPath: f.specPath,
    operation: 'VALIDATE_SLICE', slice: f.delivery.slice };
  const marker = path.join(path.dirname(f.dispatch.originFile), 'owner.json');
  const record = JSON.parse(await fs.readFile(marker)); record.runner.agentId = '/root/foreign';
  await fs.writeFile(marker, JSON.stringify(record));
  await assert.rejects(observeFormalRunner(input));
});
test('a reservation bound during observation stays pending until a fresh full designation', async t => {
  const f = await reservedOperation(t);
  let advanced = false;
  const observing = { ...product, async captureCurrentActiveExecution(...args) {
    const image = await product.captureCurrentActiveExecution(...args);
    if (!advanced) { advanced = true; await bindNative(f.start.handle, '/root/bound-during-observation'); }
    return image;
  } };
  const input = { product: observing, specPath: f.specPath, operation: 'VALIDATE_SLICE', slice: f.delivery.slice };
  assert.deepEqual(await observeFormalRunner(input), { state: 'pending' });
  const designation = await observeFormalRunner({ ...input, product });
  assert.equal(designation.agentPath, '/root/bound-during-observation');
  assert.equal(designation.dispatchId, f.dispatch.dispatchId);
});
for (const mutation of ['owner', 'dispatch', 'round', 'origin', 'outside-runner', 'unknown-status', 'agent'])
test(`a reservation changing during observation rejects ${mutation} divergence`, async t => {
  const f = await reservedOperation(t), marker = path.join(path.dirname(f.dispatch.originFile), 'owner.json');
  const observing = { ...product, async captureCurrentActiveExecution(...args) {
    const image = await product.captureCurrentActiveExecution(...args);
    await bindNative(f.start.handle, '/root/bound-during-observation');
    const record = JSON.parse(await fs.readFile(marker));
    if (mutation === 'owner') record.binding.owner.ownershipToken = 'foreign';
    if (mutation === 'dispatch') record.runner.dispatchId = 'foreign';
    if (mutation === 'round') record.runner.round = 2;
    if (mutation === 'origin') record.runner.originFile = path.join(path.dirname(f.dispatch.originFile), 'foreign.origin.json');
    if (mutation === 'outside-runner') record.phase = 'foreign';
    if (mutation === 'unknown-status') record.runner.status = 'unknown';
    if (mutation === 'agent') record.runner.agentId = '/root/foreign';
    await fs.writeFile(marker, JSON.stringify(record));
    return image;
  } };
  await assert.rejects(observeFormalRunner({ product: observing, specPath: f.specPath,
    operation: 'VALIDATE_SLICE', slice: f.delivery.slice }));
});
for (const mutation of ['agent', 'round', 'owner', 'registry']) test(`formal designation rejects ${mutation} divergence`, async t => {
  const f = await reservedOperation(t);
  await bindNative(f.start.handle, '/root/check');
  const root = path.dirname(f.dispatch.originFile), marker = path.join(root, 'owner.json');
  if (mutation === 'agent') {
    const file = path.join(root, 'round-1.agent.json');
    const value = JSON.parse(await fs.readFile(file)); value.agentId = '/root/foreign'; await fs.writeFile(file, JSON.stringify(value));
  } else if (mutation === 'registry') {
    const { workspace, context } = await product.resolveCurrentExecutionContext(f.specPath);
    const roots = await product.resolveExecutionFilesystemRoots(product.executionWorkspaceFromContext(context, workspace));
    const value = JSON.parse(await fs.readFile(roots.operationRegistry)); value.operations = []; await fs.writeFile(roots.operationRegistry, JSON.stringify(value));
  } else {
    const value = JSON.parse(await fs.readFile(marker));
    if (mutation === 'round') value.runner.round = 2;
    else value.binding.owner.operation = 'EXECUTE_SLICE';
    await fs.writeFile(marker, JSON.stringify(value));
  }
  await assert.rejects(observeFormalRunner({ product, specPath: f.specPath, operation: 'VALIDATE_SLICE', slice: f.delivery.slice }));
});
