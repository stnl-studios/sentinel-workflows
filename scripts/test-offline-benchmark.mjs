import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { OFFLINE_AUTH, OFFLINE_MARKER, OFFLINE_PROVIDER } from '../agents/codex/runtime/offline-provider-context.mjs';
import { compareMeasurements } from '../benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let happyFixture;
async function checkout(scenario) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/stnl-offline-checkout-'));
  const clone = spawnSync('git', ['clone', '--no-hardlinks', '--local', ROOT, root], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(clone.status, 0, clone.stderr);
  // Copy candidate sources before freeze, including untracked source additions.
  for (const name of ['agents', 'skills', 'scripts', 'templates', 'benchmarks']) await fs.cp(path.join(ROOT, name), path.join(root, name), {
    recursive: true, filter: (file) => !file.includes('/measurements/') && !file.endsWith('/measurements') && !file.includes('/.DS_Store'),
  });
  await fs.writeFile(path.join(root, '.offline-owned'), OFFLINE_MARKER);
  const home = path.join(root, '.offline-home');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(home, 'Library/Application Support'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/auth.json'), OFFLINE_AUTH);
  await fs.writeFile(path.join(home, '.codex/config.toml'), '# fictitious GLOBAL sentinel\n');
  await fs.writeFile(path.join(home, '.claude/settings.json'), '{"fictitious":"unchanged"}\n');
  await fs.writeFile(path.join(root, '.offline-context.json'), JSON.stringify({ mode: 'OFFLINE_TEST_ONLY', root, home, scenario,
    providerSha256: hash(await fs.readFile(path.join(root, OFFLINE_PROVIDER))) }));
  const env = { ...process.env, HOME: home, STNL_OFFLINE_PROVIDER_CONTEXT: path.join(root, '.offline-context.json'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  return { root, home, env };
}
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

test('T26/T24/T31/T32: literal npm benchmark uses real FULL runtime and fictitious GLOBAL only', { timeout: 150_000 }, async () => {
  const fixture = await checkout('full');
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

test('T15: APPLY finalizer preserves a legitimate coverage finding through correction, revalidation and budget', { timeout: 90_000 }, async () => {
  const fixture = await checkout('coverage-findings');
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

for (const first of [false, true]) test(`P2: real main SDK exception ${first ? 'before first event' : 'after prior operation'} keeps ledger, journal, case state and summary consumption consistent`, { timeout: 90_000 }, async () => {
  const fixture = await checkout(first ? 'main-first-exception' : 'main-exception');
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
  test(`T05: literal npm settles owned pending runner after ${signal ?? 'main completion'}`, { timeout: 150_000 }, async () => {
    const fixture = await checkout(signal ? 'interrupt' : 'pending-main'); console.log(`TEST-ONLY evidence: ${fixture.root}`);
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
  test(`T23/T27: literal npm provider failure in ${blockedCase} preserves sibling outcomes and started consumption`, { timeout: 150_000 }, async () => {
    const fixture = await checkout(`block-${blockedCase.toLowerCase()}`);
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

test('T06: literal npm main completing without a runner request blocks with zero runner cost', { timeout: 150_000 }, async () => {
  const fixture = await checkout('zero-runner'); console.log(`TEST-ONLY evidence: ${fixture.root}`);
  const result = await npm(fixture); assert.equal(result.code, 1, result.stdout + result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmarks/sentinel-todo/measurements/latest.json')));
  const state = JSON.parse(await fs.readFile(path.join(fixture.root, 'benchmark-temp', report.run.id, 'case-a/case-state.json')));
  assert.equal(state.terminal.blocker, 'OFFICIAL_RUNNER_RECEIPT_MISSING');
  assert.equal(state.runnerTurns, 0);
  const operation = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
  assert.match(operation.outcome.diagnostic, /No managed runner request/u);
  assert.equal(operation.runner.requestsHandled, 0);
});

test('T13: literal npm retains a real failing check privately before corrected round 2 passes', { timeout: 150_000 }, async () => {
  const fixture = await checkout('private-retry'); console.log(`TEST-ONLY evidence: ${fixture.root}`);
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

test('T28/T29: literal npm refuses history collision, unowned scratch and failed verify before dispatch/cleanup', { timeout: 150_000 }, async () => {
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

test('T23: manager cancellation settles both barrier-held sibling provider processes', { timeout: 150_000 }, async () => {
  const fixture = await checkout('interrupt-siblings'); console.log(`TEST-ONLY evidence: ${fixture.root}`);
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

test('T30: real manager resumes FOCAL_STOP with original snapshot and refuses terminal reopen', { timeout: 150_000 }, async () => {
  const fixture = await checkout('full'); console.log(`TEST-ONLY evidence: ${fixture.root}`);
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
