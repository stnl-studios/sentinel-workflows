import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindManagedFindingsCycle, deriveManagedFindingsOwnership, assertManagedFindingsOwnership, findingsOwnershipFingerprint } from '../agents/codex/runtime/managed-findings-cycle.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseSemanticExecutionPayload } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
for (const slice of ['slice-02', 'slice-11']) {
  test(`sealed ownership derives diverse active IDs and the current cycle in ${slice}`, () => {
    const liveText = '## Validation Attempts\n\n### attempt-03\n- Status: NEEDS_FIX\n\n## Validation Findings\n\n### finding-07\n- Origin: attempt-01\n- State: active\n\n### finding-23\n- Origin: attempt-02\n- State: active\n';
    const context = { operation: 'APPLY_FINDINGS', slice, workspace: '/TEST-ONLY/workspace', authority: 'sha256:' + 'a'.repeat(64) };
    const binding = { ...context, sequence: 8, nonce: 'owned-test-nonce', candidateTaskArtifact: '/TEST-ONLY/candidate/' + slice + '.md', sourceTaskSha256: createHash('sha256').update(liveText).digest('hex') };
    const selected = { attempts: [{ id: 'attempt-03', status: 'NEEDS_FIX' }], findings: [
      { id: 'finding-23', state: 'active', origin: 'attempt-02' }, { id: 'finding-07', state: 'active', origin: 'attempt-01' }] };
    const request = { ...context, sequence: 8, managedPayload: { automaticCheckRound: '1/3', activeFindings: ['finding-99: context description only'] } };
    const input = { context, binding, selected, request, fingerprint: 'a'.repeat(64), candidateText: liveText, liveText,
      candidateTreeSha256: 'b'.repeat(64), sourceTestsSha256: 'c'.repeat(64), testedStateSha256: 'd'.repeat(64) };
    const ownership = deriveManagedFindingsOwnership(input);
    assert.deepEqual(ownership.activeFindings, ['finding-07', 'finding-23']);
    assert.equal(ownership.canonicalCycle, 'attempt-03');
    const receipt = { sequence: 8, slice, authority: context.authority, automaticCheckRound: '1/3', findingsOwnershipSha256: findingsOwnershipFingerprint(ownership) };
    const sealed = { ...request, findingsOwnership: ownership };
    for (const value of [undefined, null, 'attempt-99', 'slice-02 finding-01', 7, false, ['guess'], { nested: [null, true] }]) {
      const response = { automaticCheckRound: '1/3', ...(value === undefined ? {} : { findingsCycle: value }) };
      const before = JSON.stringify(response);
      const bound = bindManagedFindingsCycle({ ...input, sealed, receipt, response });
      assert.equal(bound.canonicalCycle, 'attempt-03');
      assert.equal(JSON.stringify(response), before);
      assert.deepEqual(bound.activeFindings, ownership.activeFindings);
    }
    for (const field of ['canonicalCycle', 'slice', 'sequence', 'authority', 'fingerprint', 'automaticCheckRound',
      'candidateNonce', 'candidateTaskArtifact', 'sourceTaskSha256', 'candidateInputSha256', 'candidateTreeSha256', 'sourceTestsSha256', 'testedStateSha256', 'activeFindings']) {
      const invalid = { ...ownership, [field]: 'conflicting value' };
      assert.throws(() => bindManagedFindingsCycle({ ...input, sealed: { ...sealed, findingsOwnership: invalid }, receipt, response: { automaticCheckRound: '1/3' } }));
      assert.throws(() => assertManagedFindingsOwnership(ownership, invalid));
    }
    assert.throws(() => bindManagedFindingsCycle({ ...input, sealed, receipt: { ...receipt, findingsOwnershipSha256: 'changed' }, response: { automaticCheckRound: '1/3' } }));
    assert.throws(() => bindManagedFindingsCycle({ ...input, sealed, receipt: { ...receipt, automaticCheckRound: '2/3' }, response: {} }));
    assert.throws(() => deriveManagedFindingsOwnership({ ...input, candidateText: liveText.replace('- State: active', '- State: resolved') }));
  });
}
test('legacy findingsCycle is optional arbitrary JSON; all judgment fields retain strict parsing', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/runner-apply-findings-response.schema.json')));
  assert.ok(!schema.required.includes('findingsCycle'));
  assert.equal(schema.properties.findingsCycle.type, undefined);
  const response = Object.fromEntries(schema.required.map(key => [key, 'checked']));
  Object.assign(response, { status: 'TESTS_PASS', automaticCheckRound: '1/3', commands: [{ command: 'node --test', exit: 0 }] });
  for (const value of [undefined, null, 'attempt-99', 4, true, [], { body: '\n`arbitrary legacy data`' }]) {
    const text = JSON.stringify({ ...response, ...(value === undefined ? {} : { findingsCycle: value }) });
    const parsed = parseSemanticExecutionPayload(text, 'APPLY_FINDINGS');
    assert.equal(JSON.stringify(parsed), text);
    assert.equal(parsed.findingsVerified, response.findingsVerified);
    assert.equal(parsed.unsupportedActiveFindings, response.unsupportedActiveFindings);
  }
  assert.throws(() => parseSemanticExecutionPayload('{broken JSON', 'APPLY_FINDINGS'));
  const missing = { ...response }; delete missing.findingsVerified;
  for (const malformed of [missing, { ...response, findingsVerified: [] }, { ...response, commands: [{ command: 'node --test', exit: '0' }] }, { ...response, unknown: 1 }]) {
    assert.throws(() => parseSemanticExecutionPayload(JSON.stringify(malformed), 'APPLY_FINDINGS'));
  }
});
test('sealed findings ownership survives absent and arbitrary legacy data across two real captured rounds', { timeout: 90_000 }, async t => {
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
  assert.equal(probes.blocked.length, 13);
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
  const sealed = await Promise.all((await fs.readdir(directory)).filter(name => name.startsWith('sealed-'))
    .map(async name => JSON.parse(await fs.readFile(path.join(directory, name)))));
  const applySeals = sealed.filter(record => record.operation === 'APPLY_FINDINGS');
  assert.equal(applySeals.length, 2);
  assert.ok(applySeals.every(record => record.managedPayload.activeFindings[0].includes(': Assert')
    && record.findingsOwnership.activeFindings.join() === 'finding-01' && record.findingsOwnership.canonicalCycle === 'attempt-01'));
  assert.deepEqual(applySeals.map(record => record.findingsOwnership.automaticCheckRound).sort(), ['1/3', '2/3']);
  assert.ok(audits.every(audit => !('reportedCycle' in audit.findingsCycleBinding)));
  assert.ok(audits.every(audit => audit.status === 'PREPARED' && audit.findingsCycleBinding.canonicalCycle === 'attempt-01'
    && audit.findingsCycleBinding.method === 'sealed-state-ownership' && /^[0-9a-f]{64}$/.test(audit.findingsCycleBinding.findingsEvidenceSha256)
    && audit.findingsCycleBinding.activeFindings.join() === 'finding-01'));
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, stem + '.finalization.json'))).state, 'FINDINGS_CORRECTED');
  for (const receipt of [observed.firstReceipt, observed.secondReceipt]) {
    assert.equal(receipt.testedState.entries.length, 6);
    assert.match(receipt.findingsOwnershipSha256, /^[0-9a-f]{64}$/);
    const raw = JSON.parse(await fs.readFile(receipt.semanticResponseFile));
    if (receipt.attempt === 1) assert.ok(!('findingsCycle' in raw));
    else assert.deepEqual(raw.findingsCycle, { slice: 'slice-02', text: 'attempt-99', values: [null, 7, true] });
    assert.deepEqual(raw.automaticCheckRound, receipt.attempt === 1 ? { legacy: '3/3' } : null);
    assert.equal(receipt.automaticCheckRound, receipt.attempt === 1 ? '1/3' : '2/3');
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
