import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { OFFLINE_AUTH } from '../agents/codex/runtime/offline-provider-context.mjs';
import { createOfflineCheckout, finishOfflineFixture } from './fixtures/offline-checkout.mjs';
import { compareMeasurements } from '../benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let happyFixture;
const checkout = (scenario, t, options) => createOfflineCheckout(t, ROOT, scenario, options);
// The happy fixture also belongs to T28/T29; release it after suite consumers.
after(async () => { if (happyFixture) await finishOfflineFixture(happyFixture); });
async function npm(fixture, onStart = () => {}) {
  const command = ['run', 'benchmark'];
  const child = spawn('npm', command, { cwd: fixture.root, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const steering = Promise.resolve(onStart(child));
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  await steering;
  await fs.writeFile(path.join(fixture.root, '.offline-npm.log'), stdout + '\n' + stderr);
  return { code, stdout, stderr };
}

test('T26/T24/T31/T32: literal npm benchmark uses real FULL runtime and fictitious GLOBAL only', { timeout: 150_000 }, async (t) => {
  const fixture = await checkout('full', t, { shared: true });
  happyFixture = fixture;
  console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const sentinels = ['.codex/auth.json', '.codex/config.toml', '.claude/settings.json'];
  const before = await Promise.all(sentinels.map((file) => fs.readFile(path.join(fixture.home, file))));
  const result = await npm(fixture);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  assert.equal(report.run.mode, 'full'); assert.equal(report.run.status, 'PASS');
  assert.equal(report.provenance.executionMode, 'OFFLINE_TEST_ONLY');
  assert.deepEqual(report.cases.map((c) => [c.id, c.status, c.execution, c.specClosed, c.finalTestsPassed]),
    ['A', 'B', 'C'].map((id) => [id, 'PASS', 'COMPLETE', true, true]));
  assert.equal(compareMeasurements(report, report).directlyComparable, false);
  assert.equal(compareMeasurements(report, report).deltas, 'unavailable');
  assert.equal(report.aggregate.telemetry.main, 'unavailable');
  assert.equal(report.aggregate.telemetry.runner, 'unavailable');
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 0); assert.ok(calls.every((call) => call.externalCalls === 0));
  assert.deepEqual(calls.filter((c) => c.independent).map((c) => c.caseId).sort(), ['A', 'A', 'B', 'B', 'C', 'C']);
  for (let index = 0; index < sentinels.length; index++) assert.deepEqual(await fs.readFile(path.join(fixture.home, sentinels[index])), before[index]);
  const globalEntries = await fs.readdir(path.join(fixture.home, 'Library/Application Support'));
  assert.deepEqual(globalEntries, [], 'private homes were removed by the owned runtime');
});

async function ready(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await fs.readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('owned fixture barrier timed out: ' + file);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('finalizer: validation rejection preserves input and fresh proposal recovers the same receipt', { timeout: 90_000 }, async (t) => {
  const fixture = await checkout('finalize-summary-rejection', t);
  console.log(`TEST-ONLY finalizer rejection evidence: ${fixture.root}`);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'A'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(fixture.root, '.offline-finalizer-manager.log'), result.stdout + '\n' + result.stderr);
  assert.equal(result.status, 1);
  const evidenceRoot = path.join(fixture.root, '.offline-finalizer-rejection');
  const proof = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'observed.json')));
  assert.equal(proof.receipt.semanticResponseStatus, 'PASS');
  assert.equal(proof.first.exit, 1); assert.match(proof.first.diagnostic, /Diff Summary/u);
  assert.equal(proof.second.exit, 0, proof.second.diagnostic);
  assert.equal(proof.reprepare.exit, 0, proof.reprepare.diagnostic);
  assert.equal(proof.finalizationExists, true);
  assert.equal(proof.duplicate.exit, 0, proof.duplicate.diagnostic);
  assert.notEqual(proof.binding.candidateExecutionRoot, proof.rejectedInput.candidateExecutionRoot);
  assert.deepEqual(proof.rejectedInputAfter, proof.before.candidateTreeSha256);
  assert.equal(proof.checkpointAfterFirst.status, 'REJECTED');
  assert.deepEqual(proof.probes.map(probe => probe.name), ['rejected-input-edit', 'rejected-stage-edit']);
  for (const probe of proof.probes) {
    assert.equal(probe.exit, 1, probe.diagnostic);
    assert.equal(probe.foreignPreserved, true);
  }
  const read = (stage, tree, file) => fs.readFile(path.join(evidenceRoot, stage, tree, file), 'utf8');
  const section = (text, title) => new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(text)[1].trim();
  const firstTask = await read('01-after-rejected-finalize', 'candidate', 'tasks/slice-01.md');
  assert.equal(section(firstTask, 'Diff Summary'), '- pending');
  assert.equal(section(firstTask, 'Validation Attempts'), '- none');
  assert.equal(section(firstTask, 'Effective Validation Base'), '- none');
  assert.equal(section(firstTask, 'Final Result'), '- pending');
  const rejectedStage = await fs.readFile(path.join(evidenceRoot, '01-prepared-stage/tasks/slice-01.md'), 'utf8');
  assert.match(section(rejectedStage, 'Validation Attempts'), /attempt-01[\s\S]*Status: PASS/u);
  assert.equal(proof.retainedStageAfter['tasks/slice-01.md'], hash(Buffer.from(rejectedStage)).slice('sha256:'.length));
  const afterSummary = await read('02-after-summary-only-correction', 'candidate', 'tasks/slice-01.md');
  assert.equal(section(firstTask, 'Diff Summary'), '- pending');
  assert.equal(firstTask.replace(section(firstTask, 'Diff Summary'), section(afterSummary, 'Diff Summary')), afterSummary,
    'the sole fixture correction changes Diff Summary, never mechanical fields');
  assert.equal(proof.afterFirst.candidateIndexSha256, proof.afterSummary.candidateIndexSha256);
  assert.equal(proof.afterSummary.candidateTaskSha256, proof.afterSecond.candidateTaskSha256);
  for (const observed of [proof.afterFirst, proof.afterSummary]) {
    assert.equal(observed.liveTaskSha256, proof.before.liveTaskSha256);
    assert.equal(observed.liveIndexSha256, proof.before.liveIndexSha256);
    assert.deepEqual(observed.liveTreeSha256, proof.before.liveTreeSha256);
    assert.deepEqual(observed.evidenceSha256, proof.before.evidenceSha256);
  }
  assert.deepEqual(proof.afterSecond.evidenceSha256, proof.before.evidenceSha256);
  const liveFinal = await read('03-after-second-finalize', 'live', 'tasks/slice-01.md');
  assert.equal((liveFinal.match(/### attempt-/gu) ?? []).length, 1);
  assert.equal(section(liveFinal, 'Final Result'), '- PASS');
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => call.caseId === 'A' && call.externalCalls === 0));
  assert.deepEqual(calls.filter((call) => call.independent).map((call) => call.operation), ['EXECUTE_SLICE', 'VALIDATE_SLICE']);
  const caseRoot = path.resolve(path.dirname(proof.receipt.receiptFile), '..');
  const state = JSON.parse(await fs.readFile(path.join(caseRoot, 'case-state.json')));
  assert.equal(state.mainTurns, 7); assert.equal(state.runnerTurns, 2);
  await t.test('failed strict validation leaves the semantic input candidate byte-identical', () => {
    assert.equal(proof.afterFirst.candidateTaskSha256, proof.before.candidateTaskSha256);
    assert.equal(proof.afterFirst.candidateIndexSha256, proof.before.candidateIndexSha256);
  });
  await t.test('fresh summary proposal finalizes the same PASS receipt without another runner', () => {
    assert.equal(proof.second.exit, 0, proof.second.diagnostic);
  });
});

test('finalizer: NEEDS_FIX and APPLY recover a PASS receipt after disposition and summary-format rejection', { timeout: 90_000 }, async (t) => {
  const fixture = await checkout('finalize-revalidation-rejection', t);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'B'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-revalidation-summary.json')));
  assert.equal(proof.receipt.semanticResponseStatus, 'PASS');
  assert.deepEqual(proof.rejected.map(entry => entry.name), ['disposition', 'summary-format']);
  assert.match(proof.rejected[0].result.diagnostic, /attempt-02 disposition contradicts finding-01 deterministic timeline/u);
  assert.match(proof.rejected[1].result.diagnostic, /Diff Summary must contain only flat '- ' bullet lines/u);
  assert.doesNotMatch(proof.rejected[1].result.diagnostic, /placeholder/u);
  const body = (text, heading) => new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(text)[1].trim();
  assert.equal(new Set([...proof.rejected.map(entry => entry.binding.candidateExecutionRoot),
    proof.binding.candidateExecutionRoot]).size, 3, 'each correction uses a fresh candidate');
  assert.equal(proof.corrected
    .replace(body(proof.corrected, 'Validation Findings'), body(proof.fresh, 'Validation Findings'))
    .replace(body(proof.corrected, 'Diff Summary'), body(proof.fresh, 'Diff Summary')), proof.fresh,
  'only the two authorized semantic sections change before finalization');
  for (const heading of ['Validation Attempts', 'Effective Validation Base', 'Final Result', 'Delegation Blocker']) {
    assert.equal(body(proof.corrected, heading), body(proof.fresh, heading), 'semantic correction preserves mechanical ' + heading);
  }
  assert.equal(body(proof.publishedTask, 'Diff Summary'), body(proof.corrected, 'Diff Summary'));
  assert.equal(body(proof.publishedTask, 'Final Result'), '- PASS');
  assert.match(body(proof.publishedTask, 'Validation Findings'), /State: resolved[\s\S]*Resolution: attempt-02/u);
  assert.match(body(proof.publishedTask, 'Effective Validation Base'), /Origin attempt: attempt-02/u);
  assert.equal((proof.publishedTask.match(/^### attempt-/gmu) ?? []).length, 2);
  assert.deepEqual(proof.before.inputs, proof.after.inputs, 'requirements authority and source/test hashes and modes stay unchanged');
  assert.deepEqual(proof.before.evidence, proof.after.evidence, 'receipt, exact response, events and sealed request stay unchanged');
  assert.equal(proof.finalization.receiptFile, proof.receipt.receiptFile);
  assert.equal(proof.finalization.published, true);
  assert.equal(proof.final.exit, 0); assert.equal(proof.duplicate.exit, 0);
  assert.equal(proof.final.output, proof.duplicate.output, 'same-receipt duplicate finalization is idempotent');
  assert.equal(proof.finalState, 'COMPLETE');
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.externalCalls === 0 && call.caseId === 'B'));
  assert.deepEqual(calls.filter(call => call.independent).map(call => call.operation),
    ['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
  const runRoot = path.resolve(path.dirname(proof.receipt.receiptFile), '../..');
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-b/case-state.json')));
  assert.equal(state.status, 'PASS'); assert.equal(state.runnerTurns, 4);
  assert.deepEqual(state.operations.filter(entry => ['VALIDATE_SLICE', 'APPLY_FINDINGS'].includes(entry.operation))
    .map(entry => [entry.operation, entry.outcome.result]),
  [['VALIDATE_SLICE', 'NEEDS_FIX'], ['APPLY_FINDINGS', 'PASS'], ['VALIDATE_SLICE', 'PASS']]);
});

for (const boundary of ['prepare-index', 'publication-install', 'readback', 'finalization-write', 'contraproofs']) {
  test(`finalizer: ${boundary} failure allows bounded same-receipt completion`, { timeout: 90_000 }, async (t) => {
    const fixture = await checkout('finalizer-fail-' + boundary, t);
    console.log(`TEST-ONLY adjacent finalizer evidence: ${boundary} ${fixture.root}`);
    const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'A'],
      { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(path.join(fixture.root, '.offline-finalizer-manager.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status, 1);
    const root = path.join(fixture.root, '.offline-finalizer-rejection');
    const proof = JSON.parse(await fs.readFile(path.join(root, 'observed.json')));
    const injection = JSON.parse(await fs.readFile(path.join(root, 'injection-fired.json')));
    assert.equal(injection.code, 'EIO'); assert.equal(injection.testOnly, true);
    assert.equal(proof.receipt.semanticResponseStatus, 'PASS');
    assert.equal(proof.first.exit, 1); assert.match(proof.first.diagnostic, /TEST-ONLY owned filesystem fault/u);
    assert.equal(proof.finalizationExists, true);
    assert.equal(proof.duplicate.exit, 0, proof.duplicate.diagnostic);
    if (boundary === 'contraproofs') {
      assert.equal(proof.probes.length, 10);
      for (const probe of proof.probes.slice(0, -1)) {
        assert.equal(probe.exit, 1, probe.name + ': ' + probe.diagnostic);
        assert.equal(probe.livePreserved, true, probe.name);
        if (probe.name !== 'concurrent-finalization') {
          assert.equal(probe.foreignPreserved, true, probe.name);
          assert.equal(probe.finalizationExists, false, probe.name);
        }
      }
      assert.match(proof.probes.at(-2).diagnostic, /EEXIST/u);
      assert.equal(proof.probes.at(-1).exit, 0, proof.probes.at(-1).stderr);
    }
    for (const phase of [proof.afterFirst, proof.afterSummary, proof.afterSecond]) assert.deepEqual(phase.evidenceSha256, proof.before.evidenceSha256);
    assert.deepEqual(proof.afterFirst.candidateTreeSha256, proof.afterSummary.candidateTreeSha256);
    const liveAfter = await fs.readFile(path.join(root, '01-after-rejected-finalize/live/tasks/slice-01.md'), 'utf8');
    if (['prepare-index', 'publication-install'].includes(boundary)) {
      assert.deepEqual(proof.afterFirst.liveTreeSha256, proof.before.liveTreeSha256, 'uncommitted publication rolls back live exactly');
    } else {
      assert.match(liveAfter, /## Final Result\n\n- PASS/u, 'publisher committed before outer finalizer failed');
    }
    const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every((call) => call.caseId === 'A' && call.externalCalls === 0));
    assert.deepEqual(calls.filter((call) => call.independent).map((call) => call.operation), ['EXECUTE_SLICE', 'VALIDATE_SLICE']);
    assert.equal(proof.second.exit, 0, proof.second.diagnostic);
  });
}

for (const [operation, boundary] of [['execute', 'publication'], ['apply', 'publication'], ['execute', 'cleanup'], ['execute', 'source-edit']]) {
  test(`finalizer: ${operation} ${boundary} failure never appends duplicate same-receipt evidence`, { timeout: 90_000 }, async (t) => {
    const fixture = await checkout(`finalizer-fail-${operation}-${boundary}`, t);
    console.log(`TEST-ONLY adjacent ${operation} evidence: ${fixture.root}`);
    const caseId = operation === 'apply' ? 'B' : 'A';
    const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', caseId],
      { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(path.join(fixture.root, '.offline-finalizer-manager.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status, 1);
    const root = path.join(fixture.root, '.offline-finalizer-rejection');
    const proof = JSON.parse(await fs.readFile(path.join(root, 'observed.json')));
    const injection = JSON.parse(await fs.readFile(path.join(root, 'injection-fired.json')));
    assert.equal(injection.code, 'EIO'); assert.equal(injection.testOnly, true);
    assert.equal(proof.receipt.semanticResponseStatus, 'TESTS_PASS');
    assert.equal(proof.first.exit, 1); assert.match(proof.first.diagnostic, /TEST-ONLY owned filesystem fault/u);
    assert.equal(proof.finalizationExists, true);
    assert.equal(proof.duplicate.exit, 0, proof.duplicate.diagnostic);
    for (const phase of [proof.afterFirst, proof.afterSummary]) {
      assert.deepEqual(phase.evidenceSha256, proof.before.evidenceSha256);
      if (boundary !== 'cleanup') assert.deepEqual(phase.liveTreeSha256, proof.before.liveTreeSha256);
    }
    assert.deepEqual(proof.afterFirst.candidateTreeSha256, proof.afterSummary.candidateTreeSha256);
    const artifact = phase => fs.readFile(path.join(root, phase, 'candidate/tasks/slice-01.md'), 'utf8');
    const prefix = operation === 'apply' ? 'findings' : 'implementation';
    const preparedStage = await fs.readFile(path.join(root, '01-prepared-stage/tasks/slice-01.md'), 'utf8');
    assert.match(preparedStage, new RegExp(`### ${prefix}-check-01`, 'u'));
    assert.doesNotMatch(await artifact('03-after-second-finalize'), new RegExp(`### ${prefix}-check-02`, 'u'));
    const liveFinal = await fs.readFile(path.join(root, '03-after-second-finalize/live/tasks/slice-01.md'), 'utf8');
    assert.equal((liveFinal.match(new RegExp(`### ${prefix}-check-`, 'gu')) ?? []).length, 1);
    assert.deepEqual(proof.afterSecond.evidenceSha256, proof.before.evidenceSha256);
    if (boundary === 'source-edit') {
      assert.equal(proof.probes.length, 1);
      assert.equal(proof.probes[0].exit, 1);
      assert.match(proof.probes[0].diagnostic, /tested source changed/u);
      assert.equal(proof.probes[0].foreignPreserved, true);
      assert.equal(proof.probes[0].livePreserved, true);
      assert.equal(proof.probes[0].finalizationExists, false);
    }
    const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(call => call.caseId === caseId && call.externalCalls === 0));
    assert.deepEqual(calls.filter(call => call.independent).map(call => call.operation), operation === 'apply'
      ? ['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS'] : ['EXECUTE_SLICE']);
    assert.equal(proof.second.exit, 0, proof.second.diagnostic);
  });
}

for (const boundary of ['owner', 'binding']) {
  test(`finalizer: allocation failure before ${boundary} retains evidence and prepares safely`, { timeout: 90_000 }, async (t) => {
    const fixture = await checkout('allocation-fail-' + boundary, t);
    console.log(`TEST-ONLY allocation ${boundary} evidence: ${fixture.root}`);
    const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'A'],
      { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const proof = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-allocation-failure.json')));
    assert.equal(proof.first.exit, 1); assert.match(proof.first.diagnostic, /TEST-ONLY allocation fault/u);
    assert.equal(proof.second.exit, 0, proof.second.diagnostic);
    assert.equal(proof.liveUnchanged, true);
    assert.equal(proof.allocated.length, 1);
    assert.deepEqual(proof.allocatedHashesAfter, proof.allocatedHashes);
    if (boundary === 'binding') {
      assert.equal(proof.ownerBefore, proof.ownerAfter);
      assert.equal(JSON.parse(proof.ownerBefore).candidateExecutionRoot, proof.binding.candidateExecutionRoot);
    } else {
      assert.equal(proof.ownerBefore, null);
      assert.notEqual(path.basename(path.dirname(proof.binding.candidateExecutionRoot)), proof.allocated[0]);
    }
    const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(call => call.caseId === 'A' && call.externalCalls === 0));
    assert.deepEqual(calls.filter(call => call.independent).map(call => call.operation), ['EXECUTE_SLICE', 'VALIDATE_SLICE']);
  });
}

test('finalizer: private failing round remains once before authorized round two passes', { timeout: 90_000 }, async (t) => {
  const fixture = await checkout('private-retry', t);
  console.log(`TEST-ONLY private round evidence: ${fixture.root}`);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'A'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.caseId === 'A' && call.externalCalls === 0));
  assert.deepEqual(calls.filter(call => call.independent).map(call => call.operation), ['EXECUTE_SLICE', 'EXECUTE_SLICE', 'VALIDATE_SLICE']);
  const run = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).find(name => name.startsWith('run-'));
  const task = await fs.readFile(path.join(fixture.root, 'benchmark-temp', run, 'case-a/workspace/specs/benchmark-case-a/execution/tasks/slice-01.md'), 'utf8');
  assert.equal((task.match(/### implementation-check-/gu) ?? []).length, 2);
  assert.ok(task.indexOf('Status: TESTS_FAIL') < task.indexOf('Status: TESTS_PASS'));
  assert.equal((task.match(/### attempt-/gu) ?? []).length, 1);
});

test('T15: APPLY finalizer preserves a legitimate coverage finding through correction, revalidation and budget', { timeout: 90_000 }, async (t) => {
  const fixture = await checkout('coverage-findings', t);
  console.log(`TEST-ONLY APPLY evidence: ${fixture.root}`);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'B'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(fixture.root, '.offline-apply-manager.log'), result.stdout + '\n' + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => call.caseId === 'B' && call.externalCalls === 0));
  assert.deepEqual(calls.filter((call) => call.independent).map((call) => call.operation),
    ['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
  const runs = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).filter((name) => name.startsWith('run-'));
  assert.equal(runs.length, 1);
  const runRoot = path.join(fixture.root, 'benchmark-temp', runs[0]), caseRoot = path.join(runRoot, 'case-b');
  const read = async (file) => JSON.parse(await fs.readFile(path.join(runRoot, file)));
  const state = await read('case-b/case-state.json'), summary = await read('summary.json'), ledger = await read('.turn-ledger.json');
  assert.equal(state.status, 'PASS'); assert.equal(summary.status, 'PASS');
  assert.equal(state.mainTurns, 10); assert.equal(state.runnerTurns, 4);
  assert.equal(ledger.total, 14); assert.equal(summary.turnBudget.consumed, 14);
  assert.deepEqual(ledger.reservations, []);
  assert.deepEqual(ledger.turns.map((turn) => turn.number), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.ok(ledger.turns.every((turn) => turn.state === 'completed' && turn.caseId === 'B'));
  assert.equal(ledger.turns.filter((turn) => turn.operation === 'APPLY_FINDINGS' && turn.role === 'main').length, 1);
  const journal = await read('case-b/journal.json');
  assert.deepEqual(journal.events.map((event) => [event.operation, event.result]), [
    ['SPEC_INIT', 'PASS'], ['PLAN', 'PASS'], ['REVIEW_PLAN', 'PASS'], ['MATERIALIZE_TASKS', 'PASS'], ['REVIEW_TASKS', 'PASS'],
    ['EXECUTE_SLICE', 'PASS'], ['VALIDATE_SLICE', 'NEEDS_FIX'], ['APPLY_FINDINGS', 'PASS'], ['VALIDATE_SLICE', 'PASS'], ['SPEC_CLOSE', 'PASS'],
  ]);
  const section = (text, title) => new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(text)[1].trim();
  const before = await fs.readFile(path.join(fixture.root, '.offline-apply-before-task.md'), 'utf8');
  const task = await fs.readFile(path.join(state.specPath, 'execution/tasks/slice-01.md'), 'utf8');
  const initial = section(before, 'Validation Attempts');
  assert.match(initial, /### attempt-01[\s\S]*Status: NEEDS_FIX[\s\S]*exit:1/u);
  assert.ok(section(task, 'Validation Attempts').startsWith(initial + '\n\n### attempt-02'), 'initial attempt is retained byte for byte');
  assert.equal(section(task, 'Implementation Test Evidence'), section(before, 'Implementation Test Evidence'));
  assert.match(section(task, 'Validation Attempts'), /### attempt-02[\s\S]*Type: revalidation[\s\S]*Status: PASS/u);
  assert.match(section(task, 'Validation Findings'), /State: resolved[\s\S]*Origin: attempt-01[\s\S]*Resolution: attempt-02/u);
  assert.match(section(task, 'Effective Validation Base'), /^- Origin attempt: attempt-02/u);
  assert.equal(section(task, 'Final Result'), '- PASS');
  const matrixClaim = path.relative(path.join(state.specPath, 'execution/tasks'), path.join(state.workspace, 'test/offline-case.json')).split(path.sep).join('/');
  assert.equal(section(task, 'Corrections Applied'), '- `' + matrixClaim + '`');
  assert.match(section(task, 'Findings Test Evidence'), /findings-check-01[\s\S]*Status: TESTS_PASS[\s\S]*Findings cycle: attempt-01/u);
  assert.ok((await fs.readFile(path.join(state.specPath, 'execution/plans/slice-01.md'), 'utf8')).includes(matrixClaim));
  assert.equal(hash(await fs.readFile(path.join(state.workspace, 'src/cli.mjs'))).slice(7), await fs.readFile(path.join(fixture.root, '.offline-apply-source-before.sha256'), 'utf8'));
  const beforeTestHash = section(before, 'Implementation Test Evidence').match(/`[^`]*offline-case.test.mjs` \| sha256:([0-9a-f]{64})/u)[1];
  assert.equal(hash(await fs.readFile(path.join(state.workspace, 'test/offline-case.test.mjs'))).slice(7), beforeTestHash);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.workspace, 'test/offline-case.json'))).priorities, ['low', 'medium', 'high']);
  const bindings = await Promise.all([6, 7, 8, 9].map((sequence) => read(`case-b/tmp/stnl-runner-broker/${String(sequence).padStart(3, '0')}.finalization.json`)));
  assert.deepEqual(bindings.map((binding) => binding.state), ['IMPLEMENTED_AWAITING_VALIDATION', 'VALIDATION_NEEDS_FIX', 'FINDINGS_CORRECTED', 'COMPLETE']);
  const afterApply = await fs.readFile(path.join(fixture.root, '.offline-after-apply-task.md'), 'utf8');
  assert.match(section(afterApply, 'Validation Findings'), /State: active/u);
  assert.equal(section(afterApply, 'Final Result'), '- pending', 'auxiliary APPLY PASS cannot resolve formal validation');
  for (const binding of bindings) {
    assert.equal(binding.published, true);
    assert.equal(Object.keys(binding.evidenceSha256).length, 4);
    for (const [file, expected] of Object.entries(binding.evidenceSha256)) assert.equal(hash(await fs.readFile(file)).slice(7), expected);
    const receipt = JSON.parse(await fs.readFile(binding.receiptFile));
    assert.equal(receipt.formatRepair, null); assert.equal(receipt.sequence, binding.sequence);
    const events = (await fs.readFile(receipt.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const actual = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution').at(-1).item;
    assert.equal(actual.exit_code, binding.sequence === 7 ? 1 : 0);
    assert.match(actual.command, /^STNL_VERIFICATION_COMMAND=1 /u);
  }
  assert.equal((await fs.readFile(path.join(state.workspace, 'requirements.md'))).equals(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/cases/case-b-medium.md'))), true);
  assert.match(await fs.readFile(path.join(state.specPath, 'feature_spec.md'), 'utf8'), /status: closed/u);
  assert.equal((await read('case-b/raw.json')).status, 'PASS');
});

for (const first of [false, true]) test(`P2: real main SDK exception ${first ? 'before first event' : 'after prior operation'} keeps ledger, journal, case state and summary consumption consistent`, { timeout: 90_000 }, async (t) => {
  const fixture = await checkout(first ? 'main-first-exception' : 'main-exception', t);
  console.log(`TEST-ONLY main exception evidence: ${fixture.root}`);
  const result = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'A'],
    { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(fixture.root, '.offline-main-exception.log'), result.stdout + '\n' + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const runs = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).filter((name) => name.startsWith('run-'));
  assert.equal(runs.length, 1);
  const runRoot = path.join(fixture.root, 'benchmark-temp', runs[0]);
  const read = async (file) => JSON.parse(await fs.readFile(path.join(runRoot, file)));
  const ledger = await read('.turn-ledger.json'), summary = await read('summary.json'), state = await read('case-a/case-state.json');
  const count = first ? 1 : 2;
  assert.equal(ledger.total, count); assert.equal(summary.turnBudget.consumed, count);
  assert.equal(state.mainTurns, count); assert.equal(summary.cases.A.mainTurns, count);
  assert.equal(summary.turnBudget.mainTurns, count); assert.equal(summary.turnBudget.runnerTurns, 0);
  assert.deepEqual(ledger.reservations, []);
  assert.deepEqual(ledger.turns.map((turn) => [turn.operation, turn.state]), first ? [['SPEC_INIT', 'failed']] : [['SPEC_INIT', 'completed'], ['PLAN', 'failed']]);
  assert.equal(ledger.turns.at(-1).threadId, null);
  assert.equal(state.operations.length, count);
  const evidence = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
  assert.equal(evidence.turn.turnStarted, null); assert.equal(evidence.turn.completed, false);
  if (first) assert.equal(await fs.readFile(evidence.turn.eventsPath, 'utf8'), '', 'pre-stream exception has no fabricated events');
  assert.match(evidence.outcome.diagnostic, /invalid owned TEST-ONLY offline provider context/u);
  assert.equal(evidence.outcome.blocker, 'DRIVER_FAILURE'); assert.equal(evidence.journal.exitCode, 0);
  const journal = await read('case-a/journal.json');
  assert.deepEqual(journal.events.map((event) => [event.operation, event.result]), first ? [['SPEC_INIT', 'BLOCKED']] : [['SPEC_INIT', 'PASS'], ['PLAN', 'BLOCKED']]);
  assert.equal(summary.status, 'BLOCKED'); assert.deepEqual(summary.cases.A.terminal, evidence.outcome);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8').catch((error) => { if (first && error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.length, first ? 0 : 1); if (!first) assert.equal(calls[0].operation, 'SPEC_INIT');
  assert.ok(calls.every((call) => call.externalCalls === 0));
});
for (const signal of [null, 'SIGINT', 'SIGTERM']) {
  test(`T05: literal npm settles owned pending runner after ${signal ?? 'main completion'}`, { timeout: 150_000 }, async (t) => {
    const fixture = await checkout(signal ? 'interrupt' : 'pending-main', t); console.log(`TEST-ONLY evidence: ${fixture.root}`);
    const result = await npm(fixture, async () => {
      if (signal === null) return;
      await ready(path.join(fixture.root, '.offline-runner-ready'));
      const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const managerPid = calls.findLast((call) => call.independent).managerPid;
      // Signal the exact manager PID learned from this owned provider fixture.
      process.kill(managerPid, signal);
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
    assert.notEqual(report.run.status, 'PASS');
    const caseRoot = path.join(fixture.root, 'benchmark-temp', report.run.id, 'case-a');
    const supervisor = JSON.parse(await fs.readFile(path.join(caseRoot, 'tmp/stnl-runner-broker/006.supervisor.json')));
    assert.equal(supervisor.pending, false); assert.equal(supervisor.cancelledPending, true);
    const evidence = JSON.parse(await fs.readFile(path.join(caseRoot, '06-execute_slice.json')));
    assert.match(evidence.outcome.diagnostic, /owned runner pending/u);
    assert.equal(report.cases.find((c) => c.id === 'A').runnerTurns, 1);
    const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmark-temp', report.run.id, '.turn-ledger.json')));
    assert.equal(ledger.reservations.length, 0);
    const pid = Number(await fs.readFile(path.join(fixture.root, '.offline-runner-ready')));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

for (const blockedCase of ['A', 'B', 'C']) {
  test(`T23/T27: literal npm provider failure in ${blockedCase} preserves sibling outcomes and started consumption`, { timeout: 150_000 }, async (t) => {
    const fixture = await checkout(`block-${blockedCase.toLowerCase()}`, t);
    console.log(`TEST-ONLY evidence: ${fixture.root}`);
    const result = await npm(fixture);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
    assert.equal(report.provenance.executionMode, 'OFFLINE_TEST_ONLY');
    assert.equal(report.run.status, 'BLOCKED');
    assert.equal(report.cases.find((c) => c.id === blockedCase).status, 'BLOCKED');
    assert.equal(report.cases.find((c) => c.id === blockedCase).mainTurns, 1);
    assert.equal(report.cases.find((c) => c.id === blockedCase).runnerTurns, 0);
    const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (blockedCase === 'A') {
      assert.deepEqual(report.cases.filter((c) => c.id !== 'A').map((c) => c.status), ['NOT_RUN', 'NOT_RUN']);
      assert.equal(calls.length, 1); assert.equal(calls[0].caseId, 'A');
    } else {
      assert.ok(calls.some((c) => c.caseId === 'B')); assert.ok(calls.some((c) => c.caseId === 'C'));
      assert.ok(report.cases.filter((c) => c.id !== blockedCase).every((c) => c.status === 'PASS' && c.execution === 'COMPLETE'));
    }
    const runRoot = path.join(fixture.root, 'benchmark-temp', report.run.id);
    const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
    assert.equal(ledger.reservations.length, 0);
    assert.equal(ledger.turns.filter((turn) => turn.caseId === blockedCase).length, 1);
    assert.equal(ledger.turns.find((turn) => turn.caseId === blockedCase).state, 'failed');
    assert.deepEqual(await fs.readdir(path.join(fixture.home, 'Library/Application Support')), []);
  });
}

test('T06: literal npm main completing without a runner request blocks with zero runner cost', { timeout: 150_000 }, async (t) => {
  const fixture = await checkout('zero-runner', t); console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const result = await npm(fixture); assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  const state = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmark-temp', report.run.id, 'case-a/case-state.json')));
  assert.equal(state.terminal.blocker, 'OFFICIAL_RUNNER_RECEIPT_MISSING');
  assert.equal(state.runnerTurns, 0);
  const operation = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
  assert.match(operation.outcome.diagnostic, /No managed runner request/u);
  assert.equal(operation.runner.requestsHandled, 0);
});

test('T13: literal npm retains a real failing check privately before corrected round 2 passes', { timeout: 150_000 }, async (t) => {
  const fixture = await checkout('private-retry', t); console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const result = await npm(fixture); assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  const root = path.join(fixture.root, 'benchmark-temp', report.run.id, 'case-a');
  const task = await fs.readFile(path.join(root, 'workspace/specs/benchmark-case-a/execution/tasks/slice-01.md'), 'utf8');
  assert.ok(task.indexOf('Status: TESTS_FAIL') < task.indexOf('Status: TESTS_PASS'));
  assert.equal((task.match(/### implementation-check-/gu) ?? []).length, 2);
  const supervisor = JSON.parse(await fs.readFile(path.join(root, 'tmp/stnl-runner-broker/006.supervisor.json')));
  assert.equal(supervisor.requestsHandled, 2);
  assert.equal(report.cases.find((c) => c.id === 'A').runnerTurns, 3);
});

test('T28/T29: literal npm refuses history collision, unowned scratch and failed verify before dispatch/cleanup', { timeout: 150_000 }, async (t) => {
  assert.ok(happyFixture, 'happy-path evidence is required');
  const fixture = happyFixture;
  const latest = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  const history = path.join(fixture.root, 'benchmarks/sentinel-todo/measurements', `${latest.run.id}.json`);
  const historyBytes = await fs.readFile(history);
  const calls = await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'));
  const runRoot = path.join(fixture.root, 'benchmark-temp', latest.run.id);
  await fs.writeFile(history, '{}\n');
  try {
    const collision = await npm(fixture); assert.equal(collision.code, 1); assert.match(collision.stderr, /preserv|collision|differs/u);
    assert.ok(await fs.stat(runRoot)); assert.deepEqual(await fs.readFile(history), Buffer.from('{}\n'));
    assert.deepEqual(await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl')), calls);
  } finally { await fs.writeFile(history, historyBytes); }
  const stateFile = path.join(runRoot, 'case-a/case-state.json');
  const stateBytes = await fs.readFile(stateFile), state = JSON.parse(stateBytes);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, finalizer: { ...state.finalizer, rawPath: path.join(runRoot, 'missing-raw.json') } }));
  try {
    const failedExport = await npm(fixture); assert.equal(failedExport.code, 1); assert.match(failedExport.stderr, /preserv/u);
    assert.ok(await fs.stat(runRoot)); assert.deepEqual(await fs.readFile(history), historyBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl')), calls);
  } finally { await fs.writeFile(stateFile, stateBytes); }
  const unowned = path.join(fixture.root, 'benchmark-temp/unowned-proof'); await fs.mkdir(unowned);
  const unsafe = await npm(fixture); assert.equal(unsafe.code, 1); assert.match(unsafe.stderr, /BLOCKED_CLEANUP/u);
  assert.ok(await fs.stat(unowned)); assert.ok(await fs.stat(runRoot));
  await fs.rmdir(unowned);
  const seed = path.join(fixture.root, 'benchmarks/sentinel-todo/seed/src/cli.mjs');
  const seedBytes = await fs.readFile(seed); await fs.appendFile(seed, '\n// TEST-ONLY verify failure\n');
  try {
    const failedVerify = await npm(fixture); assert.equal(failedVerify.code, 1); assert.match(failedVerify.stderr, /BLOCKED_VERIFY/u);
    assert.ok(await fs.stat(runRoot)); assert.deepEqual(await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl')), calls);
  } finally { await fs.writeFile(seed, seedBytes); }
  const activeFile = path.join(fixture.root, 'benchmark-temp/.active-run.json');
  await fs.writeFile(activeFile, JSON.stringify({ pid: process.pid, runId: latest.run.id }));
  try { const active = await npm(fixture); assert.equal(active.code, 1); assert.match(active.stderr, /BLOCKED_ACTIVE/u); assert.ok(await fs.stat(runRoot)); }
  finally { await fs.unlink(activeFile); }
  const unsafeLink = path.join(fixture.root, 'benchmark-temp/unsafe-link'); await fs.symlink(runRoot, unsafeLink);
  try { const link = await npm(fixture); assert.equal(link.code, 1); assert.match(link.stderr, /BLOCKED_CLEANUP/u); assert.ok((await fs.lstat(unsafeLink)).isSymbolicLink()); assert.ok(await fs.stat(runRoot)); }
  finally { await fs.unlink(unsafeLink); }
  const cleaned = await npm(fixture); assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
  assert.equal(await fs.stat(runRoot).then(() => true, () => false), false, 'only preserved owned terminal raw is removed');
  assert.deepEqual(await fs.readFile(history), historyBytes, 'the original report survives cleanup byte-identically');
});

test('T23: manager cancellation settles both barrier-held sibling provider processes', { timeout: 150_000 }, async (t) => {
  const fixture = await checkout('interrupt-siblings', t); console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const result = await npm(fixture, async () => {
    await Promise.all(['B', 'C'].map((id) => ready(path.join(fixture.root, `.offline-sibling-ready-${id}`), 30_000)));
    const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    process.kill(calls.findLast((call) => call.caseId === 'B').managerPid, 'SIGTERM');
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  assert.notEqual(report.run.status, 'PASS');
  assert.equal(report.cases.find((c) => c.id === 'A').status, 'PASS');
  for (const id of ['B', 'C']) {
    assert.notEqual(report.cases.find((c) => c.id === id).status, 'PASS');
    const pid = Number(await fs.readFile(path.join(fixture.root, `.offline-sibling-ready-${id}`)));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmark-temp', report.run.id, '.turn-ledger.json')));
  assert.equal(ledger.reservations.length, 0);
});

test('T30: real manager resumes FOCAL_STOP with original snapshot and refuses terminal reopen', { timeout: 150_000 }, async (t) => {
  const fixture = await checkout('full', t); console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const manager = path.join(fixture.root, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');
  const call = (args) => spawnSync(process.execPath, [manager, ...args], { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 60_000 });
  const stopped = call(['run', '--case', 'A', '--max-operations', '2']); assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  const runId = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).find((name) => name.startsWith('run-'));
  const runFile = path.join(fixture.root, 'benchmark-temp', runId, 'run.json');
  const before = JSON.parse(await fs.readFile(runFile)); assert.equal(before.status, 'FOCAL_STOP');
  const snapshotBytes = await fs.readFile(path.join(fixture.root, 'benchmark-temp', runId, 'snapshot.json'));
  const resumed = call(['run', '--resume', runId]); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const afterBytes = await fs.readFile(runFile), after = JSON.parse(afterBytes); assert.equal(after.status, 'PASS');
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(await fs.readFile(path.join(fixture.root, 'benchmark-temp', runId, 'snapshot.json')), snapshotBytes);
  const terminal = call(['run', '--resume', runId]); assert.equal(terminal.status, 1); assert.match(terminal.stderr, /only a stopped/u);
  assert.deepEqual(await fs.readFile(runFile), afterBytes);
});
