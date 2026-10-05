import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindManagedFindingsCycle } from '../agents/codex/runtime/managed-findings-cycle.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
for (const [slice, finding] of [['slice-02', 'finding-07'], ['slice-11', 'finding-23']]) {
  test(`managed findings binding uses current ${slice}/${finding} identity for exactly two type confusions`, () => {
    const liveText = `## Validation Attempts\n\n### attempt-03\n- Status: NEEDS_FIX\n\n## Validation Findings\n\n### ${finding}\n- Origin: attempt-01\n- State: active\n`;
    const context = { operation: 'APPLY_FINDINGS', slice, workspace: '/TEST-ONLY/workspace', authority: 'sha256:' + 'a'.repeat(64) };
    const binding = { ...context, sequence: 8, sourceTaskSha256: createHash('sha256').update(liveText).digest('hex') };
    const selected = { attempts: [{ id: 'attempt-03', status: 'NEEDS_FIX' }], findings: [{ id: finding, state: 'active', origin: 'attempt-01' }] };
    const sealed = { ...context, sequence: 8, managedPayload: { automaticCheckRound: '1/3', activeFindings: [finding] } };
    const receipt = { sequence: 8, slice, authority: context.authority };
    const input = { context, binding, selected, sealed, receipt, candidateText: liveText, liveText };
    const response = findingsCycle => ({ automaticCheckRound: '1/3', findingsCycle });
    for (const literal of [`${slice}; ${finding} ativo`, finding]) {
      const bound = bindManagedFindingsCycle({ ...input, response: response(literal) });
      assert.equal(bound.canonicalCycle, 'attempt-03');
      assert.equal(bound.reportedCycle, literal);
      assert.equal(bound.normalized, true);
    }
    assert.equal(bindManagedFindingsCycle({ ...input, response: response('attempt-03') }).normalized, false);
    for (const literal of ['attempt-01', 'attempt-99', 'unknown', 'finding-99',
      `slice-99; ${finding} ativo`, `${slice}; finding-99 ativo`, `${slice}; ${finding} active`,
      `${slice}; ${finding} ativo `, `${finding}, finding-99`]) {
      assert.throws(() => bindManagedFindingsCycle({ ...input, response: response(literal) }), { code: 'MANAGED_FINDINGS_BINDING_INVALID' });
    }
    const multiple = { ...input, selected: { ...selected, findings: [...selected.findings, { id: 'finding-99', state: 'active' }] },
      sealed: { ...sealed, managedPayload: { ...sealed.managedPayload, activeFindings: [finding, 'finding-99'] } } };
    for (const literal of [`${slice}; ${finding} ativo`, finding]) {
      assert.throws(() => bindManagedFindingsCycle({ ...multiple, response: response(literal) }), { code: 'MANAGED_FINDINGS_BINDING_INVALID' });
    }
  });
}
test('real malformed findings cycles survive two captured rounds only with a canonical managed binding', { timeout: 90_000 }, async t => {
  const fixture = await createOfflineCheckout(t, ROOT, 'apply-findings-cycle');
  console.log(`TEST-ONLY findings cycle fixture: ${fixture.root}`);
  const run = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'B'], {
    cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024,
  });
  await fs.writeFile(path.join(fixture.root, '.offline-findings-cycle-manager.log'), run.stdout + '\n' + run.stderr);
  const observed = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-findings-cycle-observed.json')));
  assert.equal(observed.firstFinalize, 0);
  assert.equal(observed.firstReceipt.semanticResponseStatus, 'TESTS_FAIL');
  assert.equal(observed.secondReceipt.semanticResponseStatus, 'TESTS_PASS');
  assert.deepEqual(observed.after, observed.before, 'captured receipts and raw responses/events remain byte-identical');
  assert.equal(observed.secondFinalize, 0, observed.diagnostic);
  assert.equal(run.status, 0, run.stderr);
  const probes = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-findings-cycle-probes.json')));
  assert.equal(probes.blocked.length, 14);
  assert.equal(probes.invalidAppends, 0);
  assert.equal(probes.extraProviderStarts, 0);
  assert.deepEqual(Object.values(JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-findings-private-history-probes.json')))), [true, true, true]);
  const runs = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).filter(name => name.startsWith('run-'));
  assert.equal(runs.length, 1);
  const runRoot = path.join(fixture.root, 'benchmark-temp', runs[0]);
  const caseRoot = path.join(runRoot, 'case-b');
  const state = JSON.parse(await fs.readFile(path.join(caseRoot, 'case-state.json')));
  assert.equal(state.status, 'PASS');
  const apply = state.operations.filter(entry => entry.operation === 'APPLY_FINDINGS');
  assert.equal(apply.length, 1);
  const operation = JSON.parse(await fs.readFile(apply[0].evidencePath));
  assert.equal(operation.runner.turns, 2);
  assert.equal(operation.runner.capturedReceipts, 2);
  assert.equal(operation.runner.requestsHandled, 2);
  assert.deepEqual(state.operations.filter(entry => entry.operation === 'VALIDATE_SLICE').map(entry => entry.outcome.result), ['NEEDS_FIX', 'PASS']);
  const directory = path.join(caseRoot, 'tmp/stnl-runner-broker');
  const stem = String(operation.sequence).padStart(3, '0');
  const audits = await Promise.all((await fs.readdir(directory)).filter(name => name.startsWith(stem + '.preparation-')).sort()
    .map(async name => JSON.parse(await fs.readFile(path.join(directory, name)))));
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(audit => audit.findingsCycleBinding.reportedCycle), ['slice-01; finding-01 ativo', 'finding-01']);
  assert.ok(audits.every(audit => audit.status === 'PREPARED' && audit.findingsCycleBinding.canonicalCycle === 'attempt-01'
    && audit.findingsCycleBinding.normalized && /^[0-9a-f]{64}$/.test(audit.findingsCycleBinding.findingsEvidenceSha256)
    && audit.findingsCycleBinding.activeFindings.join() === 'finding-01'));
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, stem + '.finalization.json'))).state, 'FINDINGS_CORRECTED');
  for (const receipt of [observed.firstReceipt, observed.secondReceipt]) {
    assert.equal(receipt.testedState.entries.length, 6);
    const raw = JSON.parse(await fs.readFile(receipt.semanticResponseFile));
    assert.equal(raw.findingsCycle, receipt.attempt === 1 ? 'slice-01; finding-01 ativo' : 'finding-01');
    assert.equal(raw.automaticCheckRound, receipt.attempt === 1 ? '1/3' : '2/3');
    assert.ok(raw.commands.some(command => receipt.attempt === 1 ? command.exit !== 0 : command.exit === 0));
  }
  assert.equal((await fs.readdir(path.join(caseRoot, 'tmp'))).filter(name => name.startsWith(stem + '-apply_findings-') && name.endsWith('.started.json')).length, 2);
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  assert.equal(ledger.total, state.mainTurns + state.runnerTurns);
  assert.equal(ledger.reservations.length, 0);

  assert.match(observed.privateTask, /### findings-check-01[\s\S]*- Findings cycle: attempt-01/);
  assert.match(observed.publishedTask, /### findings-check-02[\s\S]*- Findings cycle: attempt-01/);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.independent && call.operation === 'APPLY_FINDINGS').length, 2);
  assert.ok(calls.every(call => call.caseId === 'B' && call.externalCalls === 0));
});
