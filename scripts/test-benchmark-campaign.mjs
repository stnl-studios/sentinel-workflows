import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { campaignSummary, runCampaign, runFunctionalBenchmark } from '../benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs';
import { publishMeasurement } from '../benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs';
import { currentFunctionalIdentity } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'benchmarks/sentinel-todo/baselines/baseline-v1.json';
const MANIFEST = 'benchmarks/sentinel-todo/benchmark.json';
const IDENTITY = 'sha256:fixture-campaign-source';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-campaign-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of [BASELINE, MANIFEST]) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, name), target);
  }
  const scratch = path.join(root, 'benchmark-temp');
  const durable = path.join(root, 'benchmarks/sentinel-todo/measurements/campaign-test-12345678');
  const baseline = JSON.parse(await fs.readFile(path.join(root, BASELINE), 'utf8'));
  const calls = [];
  let runs = 0;
  const hooks = {
    gitState: () => { calls.push('preflight'); if (options.dirty) throw Object.assign(new Error('dirty checkout'), { code: 'BLOCKED_BASE' }); return { head: 'fixture-head' }; },
    processes: () => { calls.push('processes'); return options.activeProcess ? ['123 benchmark-manager.mjs'] : []; },
    identity: () => { calls.push('identity'); return { sha256: options.sourceDrift && runs > 0 ? 'sha256:changed' : IDENTITY }; },
    verify: async () => { calls.push('verify'); return { code: 0 }; },
    runFull: async () => {
      runs += 1; calls.push(`run-${runs}`);
      assert.equal(await fs.stat(durable).then(() => true, () => false), false, 'promotion must wait for the full run');
      for (let previous = 1; previous < runs; previous += 1) {
        assert.equal(await fs.stat(path.join(scratch, 'campaign-test-12345678', `run-0${previous}.json`)).then(() => true, () => false), true,
          'previous report must remain in scratch');
      }
      const runId = `run-fixture-${runs}`;
      const runRoot = path.join(scratch, runId);
      await fs.mkdir(runRoot);
      await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
      const status = options.blockRun === runs ? 'BLOCKED' : 'PASS';
      await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ runId, status, mode: 'full',
        snapshot: { sourceFunctionalSha256: IDENTITY } }));
      await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runId, status,
        cases: Object.fromEntries(['A', 'B', 'C'].map((key) => [key, { status: status === 'PASS' ? 'PASS' : 'BLOCKED', terminal: { blocker: status === 'PASS' ? null : 'FIXTURE_BLOCKER' } }])) }));
      if (options.cancelRun === runs) process.emit('SIGINT');
      return { code: status === 'PASS' ? 0 : 1 };
    },
    export: async (runId, output) => {
      calls.push(`export-${runId}`);
      const report = structuredClone(baseline);
      delete report.baselineVersion; delete report.baselineIdentity;
      report.run.id = runId;
      report.provenance.sourceFunctionalSha256 = IDENTITY;
      await fs.writeFile(output, JSON.stringify(report));
      return { code: 0 };
    },
    compare: (_before, report) => { calls.push(`compare-${report.run.id}`);
      return options.incomparable ? { directlyComparable: false, mismatches: ['metricDefinitions'] }
        : { directlyComparable: true, mismatches: [], profileExperiment: false, deltas: { g2: {}, g3: {} } }; },
  };
  return { root, scratch, durable, calls, hooks, get runs() { return runs; } };
}

async function campaign(f) {
  return runCampaign({ root: f.root, hooks: f.hooks, campaignId: 'campaign-test-12345678' });
}

test('happy path runs A+B+C once and promotes one source-pure report', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.scratch);
  await fs.writeFile(path.join(f.scratch, '.turn-ledger.json'), '{}');
  const result = await campaign(f);
  assert.equal(result.status, 'CAMPAIGN_COMPLETE');
  assert.equal(result.plannedRuns, 1);
  assert.equal(result.completedRuns, 1);
  assert.equal(result.successRate, 1);
  assert.equal(result.distribution.g2.operations.sampleCount, 1);
  assert.deepEqual(f.calls.filter((x) => /^(verify|run-|export-|compare-)/u.test(x)), [
    'verify', 'run-1', 'export-run-fixture-1', 'compare-run-fixture-1',
  ]);
  assert.equal(await fs.stat(path.join(f.scratch, '.turn-ledger.json')).then(() => true, () => false), false);
  assert.deepEqual((await fs.readdir(f.durable)).sort(), ['campaign-summary.json', 'run-01.json']);
  const promotedSummary = JSON.parse(await fs.readFile(path.join(f.durable, 'campaign-summary.json'), 'utf8'));
  assert.equal(promotedSummary.plannedRuns, 1);
  assert.equal(promotedSummary.completedRuns, 1);
  assert.equal(promotedSummary.runs.length, 1);
  assert.equal((await fs.readdir(path.join(f.scratch, 'campaign-test-12345678'))).includes('compare-01.json'), true);
  assert.equal((await fs.readdir(path.join(f.scratch, 'campaign-test-12345678'))).includes('compare-02.json'), false);
  assert.equal(result.sourceFunctionalSha256, IDENTITY);
});

test('fresh machine initializes absent scratch', async (t) => {
  const f = await fixture(t);
  await campaign(f);
  assert.equal(f.runs, 1);
});

test('actual functional identity excludes staged reports in benchmark-temp', async () => {
  const scratchReport = path.join(ROOT, 'benchmark-temp', `campaign-source-test-${process.pid}`, 'run-01.json');
  const before = await currentFunctionalIdentity();
  await fs.mkdir(path.dirname(scratchReport), { recursive: true });
  try {
    await fs.writeFile(scratchReport, '{"staged":true}\n');
    assert.deepEqual(await currentFunctionalIdentity(), before);
  } finally {
    await fs.rm(path.dirname(scratchReport), { recursive: true, force: true });
  }
});

test('run 1 blocker prevents run 2 and preserves raw evidence', async (t) => {
  const f = await fixture(t, { blockRun: 1 });
  await assert.rejects(campaign(f), /FIXTURE_BLOCKER/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
  assert.equal((await fs.readdir(f.scratch)).includes('run-fixture-1'), true);
});

test('two samples have an even median and partial coverage remains unavailable', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE), 'utf8'));
  const reports = [structuredClone(baseline), structuredClone(baseline)];
  reports[0].aggregate.operations = 10;
  reports[1].aggregate.operations = 14;
  reports[1].aggregate.telemetry.main = 'unavailable';
  const summary = campaignSummary({ campaignId: 'campaign-test-12345678', head: 'fixture-head',
    startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', baselineRef: {},
    reports, comparisons: [{}, {}], plannedRuns: 2 });
  assert.deepEqual(summary.distribution.g2.operations.values.map(({ value }) => value), [10, 14]);
  assert.equal(summary.distribution.g2.operations.sampleCount, 2);
  assert.equal(summary.distribution.g2.operations.median, 12);
  assert.equal(summary.distribution.g2.operations.min, 10);
  assert.equal(summary.distribution.g2.operations.max, 14);
  assert.equal(summary.distribution.g3.mainInput.sampleCount, 1);
  assert.equal(summary.distribution.g3.mainInput.median, 'unavailable');
});

test('one numeric sample has identical median and extremes while missing telemetry stays unavailable', async () => {
  const report = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE), 'utf8'));
  report.aggregate.operations = 11;
  report.aggregate.telemetry.main = 'unavailable';
  const summary = campaignSummary({ campaignId: 'campaign-test-12345678', head: 'fixture-head',
    startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', baselineRef: {},
    reports: [report], comparisons: [{}], plannedRuns: 1 });
  assert.equal(summary.plannedRuns, 1);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.successRate, 1);
  assert.deepEqual([summary.distribution.g2.operations.sampleCount, summary.distribution.g2.operations.median,
    summary.distribution.g2.operations.min, summary.distribution.g2.operations.max], [1, 11, 11, 11]);
  assert.equal(summary.distribution.g3.mainInput.median, 'unavailable');
  assert.deepEqual(summary.gateDecision, { G2: 'PENDING', G3: 'PENDING' });
});

test('comparison failure stops and does not promote', async (t) => {
  const f = await fixture(t, { incomparable: true });
  await assert.rejects(campaign(f), /metricDefinitions/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
});

test('dirty checkout blocks before cleanup or provider', async (t) => {
  const f = await fixture(t, { dirty: true });
  await fs.mkdir(f.scratch);
  await fs.writeFile(path.join(f.scratch, 'sentinel'), 'keep');
  await assert.rejects(campaign(f), /dirty checkout/u);
  assert.equal(await fs.readFile(path.join(f.scratch, 'sentinel'), 'utf8'), 'keep');
  assert.equal(f.runs, 0);
});

test('active benchmark marker blocks and leaves temp intact', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.scratch);
  await fs.writeFile(path.join(f.scratch, '.active-run.json'), '{}');
  await assert.rejects(campaign(f), /active or interrupted benchmark marker/u);
  assert.equal(await fs.stat(path.join(f.scratch, '.active-run.json')).then(() => true, () => false), true);
  assert.equal(f.runs, 0);
});

test('ambiguous case state blocks scratch cleanup', async (t) => {
  const f = await fixture(t);
  const runRoot = path.join(f.scratch, 'run-ambiguous-123');
  await fs.mkdir(path.join(runRoot, 'case-a'), { recursive: true });
  await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ status: 'BLOCKED' }));
  await fs.writeFile(path.join(runRoot, 'summary.json'), '{}');
  await fs.writeFile(path.join(runRoot, 'case-a/case-state.json'), JSON.stringify({ status: 'ACTIVE' }));
  await assert.rejects(campaign(f), /active or ambiguous case state/u);
  assert.equal(await fs.stat(runRoot).then(() => true, () => false), true);
  assert.equal(f.runs, 0);
});

test('known live process blocks before cleanup', async (t) => {
  const f = await fixture(t, { activeProcess: true });
  await fs.mkdir(f.scratch);
  await fs.writeFile(path.join(f.scratch, 'sentinel'), 'keep');
  await assert.rejects(campaign(f), /another benchmark process/u);
  assert.equal(await fs.readFile(path.join(f.scratch, 'sentinel'), 'utf8'), 'keep');
});

test('destination collision never overwrites existing reports', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.durable, { recursive: true });
  await fs.writeFile(path.join(f.durable, 'campaign-summary.json'), 'existing');
  await assert.rejects(campaign(f), /already exists/u);
  assert.equal(await fs.readFile(path.join(f.durable, 'campaign-summary.json'), 'utf8'), 'existing');
  assert.equal(f.runs, 0);
});

test('SIGINT cancels and never starts next run or promotes', async (t) => {
  const f = await fixture(t, { cancelRun: 1 });
  await assert.rejects(campaign(f), /campaign interrupted/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
  const state = JSON.parse(await fs.readFile(path.join(f.scratch, 'campaign-test-12345678/state.json'), 'utf8'));
  assert.equal(state.status, 'CANCELLED');
});

test('source drift after run 1 blocks before run 2', async (t) => {
  const f = await fixture(t, { sourceDrift: true });
  await assert.rejects(campaign(f), /functional source changed/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
});

test('npm benchmark is an isolated full run and formal campaign stays explicit', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.benchmark, 'node benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs --functional');
  assert.equal(pkg.scripts['benchmark:campaign'], 'node benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs');
  assert.match(pkg.scripts.benchmark, /--functional/u);
  assert.doesNotMatch(pkg.scripts.benchmark, /benchmark:campaign/u);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs'), '--help'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Functional single run: npm run benchmark/u);
  assert.match(result.stdout, /Formal 1-full campaign: npm run benchmark:campaign/u);
});

async function functionalFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-functional-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'benchmark-temp');
  const measurements = path.join(root, 'benchmarks/sentinel-todo/measurements');
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE), 'utf8'));
  const calls = []; const saved = new Map(); let runs = 0;
  const hooks = {
    verify: async () => { calls.push('verify'); return { code: 0 }; },
    processes: () => [],
    runFull: async () => {
      runs += 1; calls.push(`run-${runs}`);
      const id = `run-functional-${runs}`; const runRoot = path.join(scratch, id);
      await fs.mkdir(runRoot, { recursive: true });
      await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
      const status = options.status ?? 'PASS';
      await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ runId: id, status, mode: 'full', cases: ['A', 'B', 'C'] }));
      await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runId: id, status, mode: 'full',
        cases: { A: { status: status === 'PASS' ? 'PASS' : 'BLOCKED' },
          B: { status: status === 'PASS' ? 'PASS' : 'NOT_RUN' }, C: { status: status === 'PASS' ? 'PASS' : 'NOT_RUN' } } }));
      for (const caseId of status === 'PASS' ? ['A', 'B', 'C'] : ['A']) {
        const caseRoot = path.join(runRoot, `case-${caseId.toLowerCase()}`);
        await fs.mkdir(caseRoot);
        await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({ caseId,
          status: status === 'PASS' ? 'PASS' : 'BLOCKED', privateHomeRemoved: true }));
      }
      if (options.cancelRun) process.emit('SIGINT');
      return { code: status === 'PASS' ? 0 : 1 };
    },
    exportMeasurement: async (id) => {
      calls.push(`export-${id}`);
      const report = structuredClone(baseline);
      report.run.id = id; report.run.status = options.status ?? 'PASS';
      if (report.run.status !== 'PASS') {
        report.cases[0].status = report.run.status;
        for (const row of report.cases.slice(1)) row.status = 'NOT_RUN';
      }
      return report;
    },
    publishMeasurement: async (report, args) => {
      calls.push(`publish-${report.run.id}`);
      if (options.publishFailure) throw new Error('fixture publish failure');
      saved.set(report.run.id, args);
      return publishMeasurement(report, args);
    },
    cleanRun: async (id) => { calls.push(`clean-${id}`); await fs.rm(path.join(scratch, id), { recursive: true }); return { code: 0 }; },
  };
  return { root, scratch, measurements, baseline, calls, saved, hooks, get runs() { return runs; } };
}

test('functional mode handles absent scratch and archives a terminal run before the next run', async (t) => {
  const f = await functionalFixture(t);
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  await fs.writeFile(path.join(f.scratch, '.campaign-state.json'), JSON.stringify({ status: 'BLOCKED' }));
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.equal(f.runs, 2);
  assert.ok(f.calls.indexOf('publish-run-functional-1') < f.calls.indexOf('clean-run-functional-1'));
  assert.ok(f.calls.includes('publish-run-functional-2'));
  assert.equal(f.saved.get('run-functional-1').updateLatest, false);
  assert.equal(f.saved.get('run-functional-2').updateLatest, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.measurements, 'run-functional-1.json'), 'utf8')).run.id, 'run-functional-1');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.measurements, 'run-functional-2.json'), 'utf8')).run.id, 'run-functional-2');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.measurements, 'latest.json'), 'utf8')).run.id, 'run-functional-2');
  assert.match(await fs.readFile(path.join(f.measurements, 'latest.md'), 'utf8'), /run-functional-2\.json/u);
  assert.equal(await fs.stat(path.join(f.scratch, 'run-functional-1')).then(() => false, () => true), true);
  assert.equal(await fs.stat(path.join(f.scratch, 'run-functional-2')).then(() => true, () => false), true);
  assert.equal((await fs.readdir(f.scratch)).some((name) => name.startsWith('run-')), true);
  assert.equal((await fs.readdir(f.scratch)).includes('.campaign-state.json'), false);
});

for (const [name, mode, caseId, status, uncreated] of [
  ['individual A PASS', 'case', 'A', 'PASS', false],
  ['individual B PASS', 'case', 'B', 'PASS', false],
  ['terminal focal', 'focal', 'A', 'FOCAL_STOP', false],
  ['zero-turn startup failure', 'full', 'A', 'BLOCKED', true],
]) test(`functional cleanup accepts ${name} and only publishes full measurements`, async (t) => {
  const f = await functionalFixture(t);
  const id = `run-old-${caseId.toLowerCase()}-${mode}`;
  const dir = path.join(f.scratch, id);
  const caseRoot = path.join(dir, `case-${caseId.toLowerCase()}`);
  await fs.mkdir(caseRoot, { recursive: true });
  await fs.writeFile(path.join(dir, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId: id, status, mode, cases: [caseId] }));
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ runId: id, status, mode, cases: { [caseId]: { status } } }));
  await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({ caseId, status, operations: [], mainTurns: 0,
    runnerTurns: 0, finalizer: null, ...(uncreated ? { privateHomeNotCreated: true }
      : mode === 'focal' ? { privateHomeSuspended: true, suspendedHome: { privateHome: '/fixture/suspended-owned-home' } }
        : { privateHomeRemoved: true }) }));
  await fs.writeFile(path.join(caseRoot, 'journal.json'), JSON.stringify({ events: [] }));
  const normalExport = f.hooks.exportMeasurement;
  f.hooks.exportMeasurement = async (runId) => {
    if (runId !== id) return normalExport(runId);
    f.calls.push(`export-${id}`);
    const report = structuredClone(f.baseline);
    report.run = { ...report.run, id, mode, status };
    report.cases = report.cases.filter((row) => row.id === caseId).map((row) => ({ ...row, status }));
    return report;
  };
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(dir).then(() => true, () => false), false);
  if (mode !== 'full') {
    assert.ok(f.calls.includes(`clean-${id}`));
    assert.ok(!f.calls.includes(`export-${id}`));
    assert.ok(!f.calls.includes(`publish-${id}`));
    await assert.rejects(fs.lstat(path.join(f.measurements, `${id}.json`)), { code: 'ENOENT' });
    return;
  }
  assert.ok(f.calls.indexOf(`publish-${id}`) < f.calls.indexOf(`clean-${id}`));
  const report = JSON.parse(await fs.readFile(path.join(f.measurements, `${id}.json`), 'utf8'));
  assert.equal(report.run.mode, mode);
  assert.equal(report.run.status, status);
  assert.equal(f.saved.get(id).updateLatest, false);
});

test('functional cleanup rejects activity, identity ambiguity and unsafe home evidence before dispatch', async (t) => {
  for (const variant of ['process', 'active-marker', 'ownership', 'run-id', 'summary-mode', 'case-id', 'active-case',
    'missing-case', 'missing-creation-record', 'partial-home', 'nonzero-turn', 'nonempty-journal',
    'publish-failure', 'clean-failure', 'activity-after-publication']) {
    await t.test(variant, async (child) => {
      const f = await functionalFixture(child, { publishFailure: variant === 'publish-failure' });
      const id = 'run-old-full-negative'; const dir = path.join(f.scratch, id); const caseRoot = path.join(dir, 'case-a');
      await fs.mkdir(caseRoot, { recursive: true });
      const run = { runId: id, mode: 'full', status: 'BLOCKED', cases: ['A'] };
      const summary = { runId: id, mode: 'full', status: 'BLOCKED', cases: { A: { status: 'BLOCKED' } } };
      const state = { caseId: 'A', status: 'BLOCKED', privateHomeNotCreated: true,
        mainTurns: 0, runnerTurns: 0, operations: [], finalizer: null };
      if (variant === 'process') f.hooks.processes = () => ['fixture benchmark-manager'];
      if (variant === 'active-marker') await fs.writeFile(path.join(f.scratch, '.active-run.json'), '{}');
      if (variant === 'run-id') run.runId = 'run-wrong-identity';
      if (variant === 'summary-mode') summary.mode = 'case';
      if (variant === 'case-id') state.caseId = 'B';
      if (variant === 'active-case') state.status = 'ACTIVE';
      if (variant === 'missing-creation-record') delete state.privateHomeNotCreated;
      if (variant === 'partial-home') state.isolationHomePath = '/fixture/unresolved-home';
      if (variant === 'nonzero-turn') state.mainTurns = 1;
      if (variant === 'clean-failure') f.hooks.cleanRun = async () => ({ code: 1, stderr: 'fixture cleanup failure' });
      if (variant === 'activity-after-publication') {
        let active = false;
        f.hooks.processes = () => active ? ['fixture benchmark-manager'] : [];
        const publish = f.hooks.publishMeasurement;
        f.hooks.publishMeasurement = async (...args) => {
          const result = await publish(...args); active = true; return result;
        };
      }
      await fs.writeFile(path.join(dir, '.sentinel-benchmark-owned'), variant === 'ownership' ? 'unowned\n' : 'sentinel-todo-run-v2\n');
      await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(run));
      await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));
      await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify(state));
      await fs.writeFile(path.join(caseRoot, 'journal.json'), JSON.stringify({ events: variant === 'nonempty-journal' ? [{}] : [] }));
      if (variant === 'missing-case') run.cases.push('B');
      await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(run));
      const before = await fs.readFile(path.join(caseRoot, 'case-state.json'));
      await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), (error) =>
        ['BLOCKED_ACTIVE', 'BLOCKED_CLEANUP'].includes(error.code));
      assert.equal(f.runs, 0);
      assert.deepEqual(await fs.readFile(path.join(caseRoot, 'case-state.json')), before);
      assert.equal((await fs.stat(dir)).isDirectory(), true);
      assert.equal(await fs.stat(path.join(f.scratch, '.campaign-active.json')).then(() => true, () => false), false);
    });
  }
});

test('functional mode preserves and removes a terminal old campaign after publishing its compact report', async (t) => {
  const f = await functionalFixture(t);
  const campaignRoot = path.join(f.scratch, 'campaign-old-12345678');
  await fs.mkdir(campaignRoot, { recursive: true });
  await fs.writeFile(path.join(campaignRoot, '.sentinel-campaign-owned'), 'sentinel-todo-campaign-v1\n');
  await fs.writeFile(path.join(campaignRoot, 'state.json'), JSON.stringify({ status: 'BLOCKED' }));
  const oldReport = structuredClone(f.baseline);
  oldReport.run.id = 'run-old-12345678';
  await fs.writeFile(path.join(campaignRoot, 'run-01.json'), JSON.stringify(oldReport));
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.ok(f.calls.includes('publish-run-old-12345678'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.measurements, 'run-old-12345678.json'), 'utf8')).run.id, 'run-old-12345678');
  assert.equal(await fs.stat(campaignRoot).then(() => true, () => false), false);
});

for (const mode of ['case', 'focal']) test(`old campaign ${mode} reports are not recreated as durable measurements`, async t => {
  const f = await functionalFixture(t);
  const campaignRoot = path.join(f.scratch, 'campaign-old-partial');
  await fs.mkdir(campaignRoot, { recursive: true });
  await fs.writeFile(path.join(campaignRoot, '.sentinel-campaign-owned'), 'sentinel-todo-campaign-v1\n');
  await fs.writeFile(path.join(campaignRoot, 'state.json'), JSON.stringify({ status: 'BLOCKED' }));
  const oldReport = structuredClone(f.baseline);
  oldReport.run.id = `run-old-partial-${mode}`; oldReport.run.mode = mode;
  await fs.writeFile(path.join(campaignRoot, 'run-01.json'), JSON.stringify(oldReport));
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.ok(!f.calls.includes(`publish-${oldReport.run.id}`));
  await assert.rejects(fs.lstat(path.join(f.measurements, `${oldReport.run.id}.json`)), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(campaignRoot), { code: 'ENOENT' });
});

test('current functional result cannot silently succeed with a case report', async t => {
  const f = await functionalFixture(t);
  const exported = f.hooks.exportMeasurement;
  f.hooks.exportMeasurement = async id => ({ ...await exported(id), run: { ...f.baseline.run, id, mode: 'case' } });
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /current benchmark report must be full/);
  assert.ok(!f.calls.includes('publish-run-functional-1'));
  assert.equal((await fs.stat(path.join(f.scratch, 'run-functional-1'))).isDirectory(), true);
});

test('functional mode refuses active and unsafe scratch without deleting it', async (t) => {
  const f = await functionalFixture(t);
  await fs.mkdir(f.scratch, { recursive: true });
  await fs.writeFile(path.join(f.scratch, '.active-run.json'), '{}');
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /active or interrupted/u);
  assert.equal(f.runs, 0);
  await fs.rm(path.join(f.scratch, '.active-run.json'));
  await fs.writeFile(path.join(f.scratch, 'unknown.txt'), 'keep');
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /unknown scratch entry/u);
  assert.equal(await fs.readFile(path.join(f.scratch, 'unknown.txt'), 'utf8'), 'keep');
});

test('functional mode publishes blocked partial results and retains original outcome on publish failure', async (t) => {
  const f = await functionalFixture(t, { status: 'BLOCKED' });
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /outcome BLOCKED/u);
  assert.ok(f.calls.includes('publish-run-functional-1'));
  assert.equal(await fs.stat(path.join(f.scratch, 'run-functional-1')).then(() => true, () => false), true);
  const g = await functionalFixture(t, { status: 'PAUSED_BUDGET_OR_QUOTA', publishFailure: true });
  await assert.rejects(runFunctionalBenchmark({ root: g.root, hooks: g.hooks }), /outcome PAUSED_BUDGET_OR_QUOTA/u);
  assert.equal(await fs.stat(path.join(g.scratch, 'run-functional-1')).then(() => true, () => false), true);
  const h = await functionalFixture(t, { status: 'CANCELLED', cancelRun: true });
  await assert.rejects(runFunctionalBenchmark({ root: h.root, hooks: h.hooks }), /outcome CANCELLED/u);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.measurements, 'latest.json'), 'utf8')).run.status, 'CANCELLED');
});

test('failure before run creation preserves latest without inventing a measurement', async (t) => {
  const f = await functionalFixture(t);
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  const latest = await fs.readFile(path.join(f.measurements, 'latest.json'));
  f.hooks.runFull = async () => ({ code: 1 });
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /created 0 run directories/u);
  assert.deepEqual(await fs.readFile(path.join(f.measurements, 'latest.json')), latest);
  assert.equal((await fs.readdir(f.measurements)).filter((name) => /^run-.*\.json$/u.test(name)).length, 1);
});
