import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { campaignSummary, runCampaign } from '../benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs';
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
      assert.equal(await fs.stat(durable).then(() => true, () => false), false, 'promotion must wait for both runs');
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

test('happy path cleans old scratch, verifies, stages two source-pure reports, then promotes', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.scratch);
  await fs.writeFile(path.join(f.scratch, '.turn-ledger.json'), '{}');
  const result = await campaign(f);
  assert.equal(result.status, 'CAMPAIGN_COMPLETE');
  assert.equal(result.plannedRuns, 2);
  assert.equal(result.completedRuns, 2);
  assert.equal(result.successRate, 1);
  assert.equal(result.distribution.g2.operations.sampleCount, 2);
  assert.deepEqual(f.calls.filter((x) => /^(verify|run-|export-|compare-)/u.test(x)), [
    'verify', 'run-1', 'export-run-fixture-1', 'compare-run-fixture-1',
    'run-2', 'export-run-fixture-2', 'compare-run-fixture-2',
  ]);
  assert.equal(await fs.stat(path.join(f.scratch, '.turn-ledger.json')).then(() => true, () => false), false);
  assert.deepEqual((await fs.readdir(f.durable)).sort(), ['campaign-summary.json', 'run-01.json', 'run-02.json']);
  const promotedSummary = JSON.parse(await fs.readFile(path.join(f.durable, 'campaign-summary.json'), 'utf8'));
  assert.equal(promotedSummary.plannedRuns, 2);
  assert.equal(promotedSummary.completedRuns, 2);
  assert.equal(promotedSummary.runs.length, 2);
  assert.equal((await fs.readdir(path.join(f.scratch, 'campaign-test-12345678'))).includes('compare-01.json'), true);
  assert.equal((await fs.readdir(path.join(f.scratch, 'campaign-test-12345678'))).includes('compare-02.json'), true);
  assert.equal(result.sourceFunctionalSha256, IDENTITY);
});

test('fresh machine initializes absent scratch', async (t) => {
  const f = await fixture(t);
  await campaign(f);
  assert.equal(f.runs, 2);
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

test('run 2 blocker stops before run 3 and preserves scratch', async (t) => {
  const f = await fixture(t, { blockRun: 2 });
  await assert.rejects(campaign(f), /FIXTURE_BLOCKER/u);
  assert.equal(f.runs, 2);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(f.scratch, 'campaign-test-12345678/run-01.json')).then(() => true, () => false), true);
  assert.equal((await fs.readdir(f.scratch)).includes('run-fixture-2'), true);
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

test('npm benchmark script resolves to campaign runner without running a provider', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.benchmark, 'node benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs');
  const result = spawnSync('npm', ['run', 'benchmark', '--', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Run the formal 2-full campaign/u);
});
