import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OFFLINE_AUTH } from '../agents/codex/runtime/offline-provider-context.mjs';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
import { claimValidationReassessment, REASSESSMENT_POLICY } from '../benchmarks/sentinel-todo/runtime/validation-reassessment.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Real manager, SDK stream, broker, guards, producers, publisher and readback;
// the only model/provider is the owned external-process fixture (zero network).
async function fixture(t, scenario, fault = null) {
  const caseId = ['reassessment-needs-fix', 'reassessment-after-fix-blocked'].includes(scenario) ? 'B' : 'A';
  const ownedFixture = await createOfflineCheckout(t, ROOT, scenario, { config: '# fictitious GLOBAL unchanged\n' });
  const { root, home, env } = ownedFixture;
  if (scenario === 'reassessment-budget' || scenario === 'reassessment-event-budget') {
    const manifestFile = path.join(root, 'benchmarks/sentinel-todo/benchmark.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile));
    if (scenario === 'reassessment-budget') manifest.turnBudget.maxTurnsPerRun = 7;
    else manifest.cases.find(item => item.id === 'A').budgets.maxWorkflowEvents = 5;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
  }
  const imports = [];
  if (fault) {
    const injection = path.join(root, '.offline-reassessment-fault.mjs');
    // Filesystem faults are confined to this disposable manager. They do not
    // replace a receipt, operation outcome or product decision.
    await fs.writeFile(injection, `import fs from 'node:fs/promises'; import path from 'node:path';
const original = { open: fs.open.bind(fs), writeFile: fs.writeFile.bind(fs), readFile: fs.readFile.bind(fs) };
const fault = ${JSON.stringify(fault)}; let fired = false;
const fail = () => { fired = true; throw Object.assign(new Error('TEST-ONLY interrupted reassessment persistence'), { code: 'EIO' }); };
fs.open = async (file, flags, mode) => {
  const handle = await original.open(file, flags, mode);
  if (!fired && fault === 'decision-write' && String(file).endsWith('/validation-reassessment-slice-01.json')) handle.writeFile = async () => fail();
  return handle;
};
fs.writeFile = async (file, bytes, options) => {
  if (!fired && String(file).includes('/case-state.json.') && String(bytes).includes('"validationReassessments"')) {
    if (fault === 'state-write') fail();
    if (fault === 'before-dispatch-source') {
      fired = true; const state = JSON.parse(String(bytes));
      await original.writeFile(path.join(state.workspace, 'src/cli.mjs'), (await original.readFile(path.join(state.workspace, 'src/cli.mjs'))) + '\\n// TEST-ONLY changed before next dispatch\\n');
    }
  }
  return original.writeFile(file, bytes, options);
};
`);
    imports.push('--import', injection);
  }
  console.log(`TEST-ONLY reassessment evidence: ${scenario} ${fault ?? ''} ${root}`);
  const result = spawnSync(process.execPath, [...imports, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', caseId],
    { cwd: root, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(root, '.offline-reassessment.log'), result.stdout + '\n' + result.stderr);
  const runNames = (await fs.readdir(path.join(root, 'benchmark-temp'))).filter(name => name.startsWith('run-'));
  assert.equal(runNames.length, 1);
  const runRoot = path.join(root, 'benchmark-temp', runNames[0]), caseRoot = path.join(runRoot, 'case-' + caseId.toLowerCase());
  const state = JSON.parse(await fs.readFile(path.join(caseRoot, 'case-state.json')));
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  const calls = (await fs.readFile(path.join(root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.externalCalls === 0 && call.caseId === caseId));
  assert.equal(ledger.total, calls.length, 'every real fixture SDK start is counted, including failures');
  assert.equal(ledger.reservations.length, 0);
  assert.equal(ledger.total, state.mainTurns + state.runnerTurns);
  assert.equal(await fs.readFile(path.join(home, '.codex/auth.json'), 'utf8'), OFFLINE_AUTH);
  assert.equal(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8'), '# fictitious GLOBAL unchanged\n');
  const task = await fs.readFile(path.join(state.specPath, 'execution/tasks/slice-01.md'), 'utf8');
  const { inspectExecutionState } = await import(path.join(root, 'skills/workflows/stnl-slice-executor/runtime/execution-state.mjs'));
  const execution = await inspectExecutionState(state.specPath);
  if (['authority-change', 'transport', 'malformed', 'broker', 'second-malformed', 'second-transport', 'before-runner-source'].some(kind => scenario === 'reassessment-' + kind)) {
    const activeFile = path.join(caseRoot, 'tmp/stnl-runner-broker/active.json');
    const active = JSON.parse(await fs.readFile(activeFile));
    const supervisorFile = path.join(path.dirname(activeFile), `${String(active.sequence).padStart(3, '0')}.supervisor.json`);
    const bytes = await fs.readFile(supervisorFile), supervisor = JSON.parse(bytes);
    assert.equal(state.status, 'BLOCKED');
    assert.equal(active.operation, 'VALIDATE_SLICE');
    assert.equal(supervisor.pending, false); assert.ok(supervisor.closedAt);
    assert.equal(supervisor.requestsHandled, scenario === 'reassessment-broker' ? 0 : 1);
    const authorityStale = scenario === 'reassessment-authority-change';
    assert.equal(supervisor.capturedReceipts, authorityStale ? 1 : 0);
    assert.equal((authorityStale ? execution.activation.lastAttempt : execution.activation.activeAttempt).operationAttemptId, active.officialPreflight.owner.operationAttemptId);
    ownedFixture.expectedStoppedValidation = { activeFile, supervisorFile, supervisorSha256: hash(bytes), authorityStale,
      sequence: active.sequence, operationAttemptId: active.officialPreflight.owner.operationAttemptId };
  }
  return { root, runRoot, caseRoot, state, ledger, calls, task, result, execution };
}
const validations = f => f.calls.filter(call => call.independent && call.operation === 'VALIDATE_SLICE');
const attempts = f => f.execution.tasks.get('slice-01').attempts.map(attempt => [attempt.id, attempt.body.match(/^- Type: (initial|revalidation)$/mu)[1], attempt.status]);

test('owner policy: captured BLOCKED becomes independent revalidation PASS with original evidence intact', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, 'reassessment-pass');
  assert.equal(f.result.status, 0, f.result.stdout + f.result.stderr);
  assert.deepEqual(attempts(f), [['attempt-01', 'initial', 'BLOCKED'], ['attempt-02', 'revalidation', 'PASS']]);
  assert.equal(validations(f).length, 2);
  assert.equal(f.state.mainTurns, 7); assert.equal(f.state.runnerTurns, 3); assert.equal(f.ledger.total, 10);
  assert.equal(f.state.status, 'PASS');
  const decision = f.state.validationReassessments['slice-01'];
  assert.equal(decision.policy, REASSESSMENT_POLICY); assert.equal(decision.originalAttempt, 'attempt-01');
  const original = JSON.parse(await fs.readFile(decision.originalEvidencePath));
  assert.equal(original.outcome.blocker, 'OFFICIAL_VALIDATION_BLOCKED');
  const firstAttempt = f.execution.tasks.get('slice-01').attempts[0];
  assert.equal(decision.proof.verifiedAttempt.attemptId, firstAttempt.id);
  assert.equal(decision.proof.verifiedAttempt.attemptSha256, hash(firstAttempt.body));
  assert.deepEqual(decision.proof.commands, firstAttempt.commands.slice(1));
  for (const [file, expected] of Object.entries(decision.proof.evidenceSha256)) {
    // Later publication legitimately advances Task/index. The concluded runner
    // receipt, events, response, proof and original outcome remain exact.
    if (file.endsWith('/tasks.md') || file.endsWith('/tasks/slice-01.md')) continue;
    assert.equal(hash(await fs.readFile(file)), expected, file);
  }
  assert.deepEqual(original.officialReadback.execution.recoveryTargets.map(target => target.operation), ['VALIDATE_SLICE', 'REPLAN']);
  assert.equal(hash(await fs.readFile(decision.originalEvidencePath)), decision.proof.evidenceSha256[decision.originalEvidencePath]);
  const next = f.state.operations.find(op => op.validationReassessment);
  assert.equal(next.validationReassessment.id, decision.id);
  const prompt = await fs.readFile(JSON.parse(await fs.readFile(next.evidencePath)).promptFile, 'utf8');
  assert.match(prompt, /no preferred verdict/u);
  assert.equal(await claimValidationReassessment(f.caseRoot, decision), null);
});

test('owner policy: a second BLOCKED is terminal without a third review', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, 'reassessment-blocked');
  assert.equal(f.result.status, 1);
  assert.deepEqual(attempts(f), [['attempt-01', 'initial', 'BLOCKED'], ['attempt-02', 'revalidation', 'BLOCKED']]);
  assert.equal(validations(f).length, 2);
  assert.equal(f.state.mainTurns, 6); assert.equal(f.state.runnerTurns, 3); assert.equal(f.ledger.total, 9);
  assert.equal(f.state.status, 'BLOCKED');
  const resume = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--resume', path.basename(f.runRoot)],
    { cwd: f.root, env: { ...process.env, HOME: path.join(f.root, '.offline-home'), STNL_OFFLINE_PROVIDER_CONTEXT: path.join(f.root, '.offline-context.json') }, encoding: 'utf8' });
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /only a stopped, single-case focal run can be resumed/u);
  assert.equal((await fs.readFile(path.join(f.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').length, f.calls.length);
});

for (const kind of ['needs-fix', 'after-fix-blocked']) test(`owner policy: ${kind} follows APPLY and retains the consumed chance`, { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, 'reassessment-' + kind);
  const passed = kind === 'needs-fix';
  assert.equal(f.result.status, passed ? 0 : 1, f.result.stdout + f.result.stderr);
  assert.deepEqual(attempts(f).map(attempt => attempt[2]), ['BLOCKED', 'NEEDS_FIX', passed ? 'PASS' : 'BLOCKED']);
  assert.equal(validations(f).length, 3, 'third validation belongs to the correction flow; there is no fourth reassessment');
  assert.deepEqual(f.state.operations.slice(4).map(op => op.operation),
    ['VALIDATE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE', ...(passed ? ['SPEC_CLOSE'] : [])]);
  assert.equal(f.state.operations.filter(op => op.validationReassessment).length, 1);
  assert.equal(f.state.mainTurns, passed ? 9 : 8); assert.equal(f.state.runnerTurns, 5);
  assert.equal(f.ledger.total, passed ? 14 : 13);
  assert.match(f.task, /Origin: attempt-02/u);
});

for (const kind of ['source-change', 'tests-change', 'seed-tests-change', 'tests-added', 'authority-change', 'access', 'transport', 'pending-command', 'malformed',
  'broker', 'capture-change', 'provenance', 'budget', 'event-budget',
  'finalized-owner', 'finalized-attempt', 'finalized-body', 'finalized-verification', 'finalized-publication', 'finalized-missing']) {
  test(`owner policy excludes ${kind} before an extra call`, { timeout: 120_000 }, async (t) => {
    const f = await fixture(t, 'reassessment-' + kind);
    assert.equal(f.result.status, 1, f.result.stdout + f.result.stderr);
    assert.equal(validations(f).length, kind === 'broker' ? 0 : 1);
    assert.equal(f.state.validationReassessments, undefined);
    assert.equal(await fs.access(path.join(f.caseRoot, 'validation-reassessment-slice-01.json')).then(() => true, () => false), false);
    const replan = f.state.operations.filter(op => op.operation === 'REPLAN');
    assert.equal(replan.length, 0, 'no follow-up is admitted without current authority and eligible proof');
    assert.equal(f.state.mainTurns, 5);
    assert.equal(f.state.runnerTurns, kind === 'broker' ? 1 : 2);
    assert.equal(f.ledger.total, kind === 'broker' ? 6 : 7);
    if (kind === 'authority-change') {
      assert.match(await fs.readFile(path.join(f.state.specPath, 'shared/requirements.md'), 'utf8'), /TEST-ONLY changed requirement authority\./);
      assert.equal(f.state.terminal.blocker, 'DRIVER_FAILURE');
      assert.match(f.state.terminal.diagnostic, /requirements authority is stale/);
      assert.deepEqual(attempts(f).map(attempt => attempt[2]), ['BLOCKED']);
    }
    if (kind.startsWith('finalized-')) {
      const mutation = JSON.parse(await fs.readFile(path.join(f.root, '.offline-reassessment-negative.json')));
      assert.equal(mutation.mutant, kind.slice('finalized-'.length));
      const evidence = JSON.parse(await fs.readFile(f.state.operations.at(-1).evidencePath));
      assert.equal(evidence.reassessmentProof.rejected, true);
      assert.match(evidence.reassessmentProof.diagnostic, /reassessment concluded receipt\/owner\/attempt differs/);
      for (const [relative, expected] of mutation.files) {
        assert.equal(hash(await fs.readFile(path.join(f.state.specPath, 'execution', relative))), expected, relative);
      }
      assert.deepEqual(attempts(f).map(attempt => attempt[2]), ['BLOCKED']);
    }
  });
}

test('owner policy: an existing interrupted decision blocks admission in the real manager', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, 'reassessment-decision-duplicate');
  assert.equal(f.result.status, 1);
  assert.equal(validations(f).length, 1); assert.equal(f.ledger.total, 7);
  assert.equal(f.state.validationReassessments, undefined);
  assert.equal((await fs.stat(path.join(f.caseRoot, 'validation-reassessment-slice-01.json'))).size, 0);
});

for (const kind of ['second-malformed', 'second-transport', 'before-runner-source']) test(`owner policy stops on ${kind}`, { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, 'reassessment-' + kind);
  assert.equal(f.result.status, 1);
  assert.equal(validations(f).length, kind === 'before-runner-source' ? 1 : 2);
  assert.deepEqual(attempts(f).map(attempt => attempt[2]), ['BLOCKED']);
  assert.equal(f.state.operations.filter(op => op.validationReassessment).length, 1);
  assert.equal(f.state.mainTurns, 6); assert.equal(f.state.runnerTurns, kind === 'before-runner-source' ? 2 : 3);
  assert.equal(f.ledger.total, kind === 'before-runner-source' ? 8 : 9);
  if (kind === 'second-malformed') assert.equal(f.state.terminal.blocker, 'OFFICIAL_RUNNER_RESULT_BLOCKED');
});

for (const fault of ['decision-write', 'state-write', 'before-dispatch-source']) {
  test(`owner policy consumes its claim despite ${fault}`, { timeout: 120_000 }, async (t) => {
    const f = await fixture(t, 'reassessment-pass', fault);
    assert.equal(f.result.status, 1);
    assert.equal(validations(f).length, 1);
    const claim = path.join(f.caseRoot, 'validation-reassessment-slice-01.json');
    assert.equal(await fs.access(claim).then(() => true, () => false), true);
    if (fault === 'decision-write') assert.equal((await fs.stat(claim)).size, 0);
    assert.equal(await claimValidationReassessment(f.caseRoot, { slice: 'slice-01', id: 'different-attempt-and-authority' }), null);
    assert.equal(f.ledger.total, 7, 'persistence/source interruption cannot allocate another SDK turn');
  });
}

test('owner policy exclusive claim admits one contender and does not reset on identity changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-reassessment-claim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const decision = { slice: 'slice-01', id: 'original', originalAttempt: 'attempt-01' };
  const results = await Promise.all(Array.from({ length: 12 }, () => claimValidationReassessment(root, decision)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(results.find(Boolean).claimFile)), decision);
  assert.equal(await claimValidationReassessment(root, { ...decision, id: 'new-fingerprint', originalAttempt: 'attempt-99' }), null);
});
