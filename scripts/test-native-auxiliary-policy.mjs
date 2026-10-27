import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { reservedOperation } from './fixtures/current-native-operation.mjs';
import { bindNative } from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import { loadProduct } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { observeFormalRunner, validateNativeLedger } from '../benchmarks/sentinel-todo/runtime/native-evidence.mjs';

const product = await loadProduct(path.resolve(import.meta.dirname, '..'));
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
