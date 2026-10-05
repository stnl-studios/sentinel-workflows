import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
import { nextFinalizedPrivateRound } from '../agents/codex/runtime/managed-apply-scope.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
test('repaired handoff preserves only the existing finalized TESTS_FAIL next-round ownership', () => {
  const context = { operation: 'APPLY_FINDINGS', slice: 'slice-01', authority: 'sha256:' + 'a'.repeat(64) };
  const previousRound = 1;
  const latest = { receipt: { status: 'RUNNER_RESPONSE_CAPTURED', semanticResponseStatus: 'TESTS_FAIL', authority: context.authority, attempt: 1, receiptFile: '/receipt-1' } };
  const finalized = { ...context, state: 'PRIVATE_TESTS_FAIL', receiptFile: '/receipt-1' };
  assert.equal(nextFinalizedPrivateRound({ round: 2, previousRound, latest, finalized, context }), true);
  assert.equal(nextFinalizedPrivateRound({ round: 2, previousRound, latest: { receipt: { ...latest.receipt, attempt: 2 } }, finalized, context }), true,
    'allocated attempt and authorized automatic round remain distinct');
  for (const round of [1, 3, 4]) assert.equal(nextFinalizedPrivateRound({ round, previousRound, latest, finalized, context }), false);
  assert.equal(nextFinalizedPrivateRound({ round: 2, previousRound, latest: { receipt: { ...latest.receipt, semanticResponseStatus: 'TESTS_PASS' } }, finalized, context }), false);
  assert.equal(nextFinalizedPrivateRound({ round: 2, previousRound, latest, finalized: null, context }), false);
  assert.equal(nextFinalizedPrivateRound({ round: 2, previousRound, latest, finalized: { ...finalized, receiptFile: '/other' }, context }), false);
});
test('APPLY one-path handoff recovers once before one six-path runner, strict finalization and VALIDATE', { timeout: 90_000 }, async t => {
  const fixture = await createOfflineCheckout(t, ROOT, 'apply-scope-repair');
  if (process.env.STNL_APPLY_SCOPE_BASELINE === '1') {
    const adapter = path.join(fixture.root, 'agents/codex/runtime/validation-runner.mjs');
    const before = await fs.readFile(adapter, 'utf8');
    const after = before.replace(/    if \(operation === 'APPLY_FINDINGS'\) Object\.assign\(managedPayload, await prepareManagedApplyScope\(\{\n      context: managed, active, tmpdir, payload: managedPayload, originalPrompt: prompt, environment \}\)\);\n/u, '');
    assert.notEqual(after, before, 'baseline removes only the new pre-dispatch repair in its own fixture');
    await fs.writeFile(adapter, after);
  }
  console.log(`TEST-ONLY scope repair fixture: ${fixture.root}`);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'B'], {
    cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024,
  });
  await fs.writeFile(path.join(fixture.root, '.offline-apply-scope-manager.log'), result.stdout + '\n' + result.stderr);
  const runs = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).filter(name => name.startsWith('run-'));
  assert.equal(runs.length, 1);
  const caseRoot = path.join(fixture.root, 'benchmark-temp', runs[0], 'case-b');
  const state = JSON.parse(await fs.readFile(path.join(caseRoot, 'case-state.json')));
  assert.equal(result.status, 0, JSON.stringify(state.terminal) + '\n' + result.stderr);
  assert.equal(state.status, 'PASS');
  const apply = state.operations.filter(entry => entry.operation === 'APPLY_FINDINGS');
  assert.equal(apply.length, 1, 'the manager never re-executes APPLY');
  assert.equal(apply[0].outcome.result, 'PASS');
  const evidence = JSON.parse(await fs.readFile(apply[0].evidencePath));
  assert.equal(evidence.runner.requestsHandled, 1);
  assert.equal(evidence.runner.capturedReceipts, 1);
  assert.equal(evidence.runner.turns, 1);
  const stem = String(evidence.sequence).padStart(3, '0');
  const directory = path.join(caseRoot, 'tmp/stnl-runner-broker');
  const repair = JSON.parse(await fs.readFile(path.join(directory, `${stem}.scope-repair.json`)));
  assert.equal(repair.rejectedBeforeDispatch, true);
  assert.equal(repair.failureCode, 'MANAGED_APPLY_SCOPE_MISMATCH');
  assert.equal(repair.repairNumber, 1);
  assert.equal(repair.invalidRequestDispatches, 0);
  assert.equal(repair.originalChangedAreas.length, 1);
  assert.equal(repair.canonicalChangedAreas.length, 6);
  assert.deepEqual(JSON.parse(repair.originalPrompt).changedAreas, repair.originalChangedAreas);
  const latest = JSON.parse(await fs.readFile(path.join(directory, `${stem}.latest.json`)));
  assert.equal(latest.receipt.testedState.entries.length, 6);
  assert.deepEqual(latest.receipt.testedState.entries.map(entry => entry.path), repair.canonicalChangedAreas);
  for (const entry of latest.receipt.testedState.entries) {
    const file = path.resolve(path.dirname(latest.receipt.testedState.sourceTaskPath), entry.path);
    assert.equal('sha256:' + createHash('sha256').update(await fs.readFile(file)).digest('hex'), entry.value);
  }
  const finalization = JSON.parse(await fs.readFile(path.join(directory, `${stem}.finalization.json`)));
  assert.equal(finalization.state, 'FINDINGS_CORRECTED');
  const validations = state.operations.filter(entry => entry.operation === 'VALIDATE_SLICE');
  assert.deepEqual(validations.map(entry => entry.outcome.result), ['NEEDS_FIX', 'PASS']);
  const probes = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-apply-scope-probes.json')));
  assert.deepEqual([probes.authorityRejected, probes.sourceRejected, probes.testsRejected, probes.budgetRejected,
    probes.capturedReceiptUnchanged, probes.repairRecordUnchanged], Array(6).fill(true));
  assert.equal(probes.negativeSdkCalls, 0);
  assert.equal(probes.repairRecords, 1);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.independent && call.operation === 'APPLY_FINDINGS').length, 1);
  assert.ok(calls.every(call => call.caseId === 'B' && call.externalCalls === 0));
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmark-temp', runs[0], '.turn-ledger.json')));
  assert.equal(ledger.total, calls.length, 'mechanical repair and denied probes never add provider starts');
  assert.equal(ledger.total, state.mainTurns + state.runnerTurns);
  assert.equal(ledger.reservations.length, 0);
});
