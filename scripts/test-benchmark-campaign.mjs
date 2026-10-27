import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { campaignSummary, runCampaign, runFunctionalBenchmark, parseCampaignArgs } from '../benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs';
import { currentFunctionalIdentity } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';
import { PRODUCT_CONTRACT, PRODUCT_CHECK_IDS, productInstrumentIdentity } from '../benchmarks/sentinel-todo/runtime/product-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'benchmarks/sentinel-todo/baselines/baseline-v1.json';
const MANIFEST = 'benchmarks/sentinel-todo/benchmark.json';
const IDENTITY = 'sha256:fixture-campaign-source';

// Synthetic orchestration input only: these receipts never qualify a real
// product. Product provenance is tested separately with the actual oracle.
function currentFixtureReport(baseline, manifest, runId) {
  const report = structuredClone(baseline);
  delete report.baselineVersion; delete report.baselineIdentity;
  Object.assign(report.run, { id: runId, profile: manifest.productionProfile.id });
  report.benchmarkVersion = manifest.benchmarkVersion;
  Object.assign(report.comparability, { profile: report.run.profile, benchmarkVersion: report.benchmarkVersion,
    productInstrumentSha256: productInstrumentIdentity() });
  report.provenance.sourceFunctionalSha256 = IDENTITY;
  for (const row of report.cases) {
    row.product = { root: `/TEST-ONLY/campaign/${runId}/${row.id}`, sha256: `sha256:${'a'.repeat(64)}` };
    row.productAcceptance = { contract: PRODUCT_CONTRACT, instrumentSha256: productInstrumentIdentity(), product: row.product,
      caseId: row.id, passed: true, checks: [...PRODUCT_CHECK_IDS[row.id]], commands: 1,
      failedCheck: null, diagnostic: null, errorCode: null };
  }
  return report;
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-campaign-test-'));
  t.after(() => process.env.STNL_OFFLINE_KEEP_FIXTURES==='1'?undefined:fs.rm(root, { recursive: true, force: true }));
  for (const name of [BASELINE, MANIFEST]) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, name), target);
  }
  const configuration = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  configuration.campaign.fullRuns = options.plannedRuns ?? 1;
  await fs.writeFile(path.join(root, MANIFEST), JSON.stringify(configuration));
  const scratch = path.join(root, 'benchmark-temp');
  const durable = path.join(root, 'benchmarks/sentinel-todo/measurements/campaign-test-12345678');
  const baseline = JSON.parse(await fs.readFile(path.join(root, BASELINE), 'utf8'));
  if (!options.historicalBaseline) {
    const comparisonBaseline = currentFixtureReport(baseline, configuration, 'run-test-only-baseline');
    comparisonBaseline.baselineVersion = 1;
    await fs.writeFile(path.join(root, BASELINE), JSON.stringify(comparisonBaseline));
  }
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
      const status = options.blockRun === runs ? 'BLOCKED' : options.pauseRun===runs?'FOCAL_STOP':'PASS';
      await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ runId, status, mode: 'full',
        ...(status==='FOCAL_STOP'?{resumeCheckpoint:'sha256:'+'a'.repeat(64)}:{}),
        snapshot: { sourceFunctionalSha256: IDENTITY } }));
      await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runId, status,mode:'full',
        cases: Object.fromEntries(['A', 'B', 'C'].map((key) => [key, { status: status === 'PASS' ? 'PASS' : status==='FOCAL_STOP'?'FOCAL_STOP':'BLOCKED', terminal: { blocker: status === 'PASS' ? null : 'FIXTURE_BLOCKER' } }])) }));
      if (options.cancelRun === runs) process.emit('SIGINT');
      return { code: ['PASS','FOCAL_STOP'].includes(status) ? 0 : 1 };
    },
    resumeFull:async runId=>{
      calls.push(`resume-${runId}`);const runRoot=path.join(scratch,runId);
      const run=JSON.parse(await fs.readFile(path.join(runRoot,'run.json'))),summary=JSON.parse(await fs.readFile(path.join(runRoot,'summary.json')));
      assert.equal(run.status,'FOCAL_STOP');run.status='PASS';delete run.resumeCheckpoint;
      summary.status='PASS';for(const row of Object.values(summary.cases))row.status='PASS';
      await fs.writeFile(path.join(runRoot,'run.json'),JSON.stringify(run));await fs.writeFile(path.join(runRoot,'summary.json'),JSON.stringify(summary));
      return {code:0};
    },
    preflightFullResume:async runId=>{calls.push(`preflight-resume-${runId}`);},
    exportMeasurement:async runId=>currentFixtureReport(baseline,configuration,runId),
    export: async (runId, output) => {
      calls.push(`export-${runId}`);
      const report = currentFixtureReport(baseline, configuration, runId);
      if (options.unqualifiedCase) delete report.cases.find(row => row.id === options.unqualifiedCase).productAcceptance;
      await fs.writeFile(output, JSON.stringify(report));
      return { code: 0 };
    },
    compare: (_before, report) => { calls.push(`compare-${report.run.id}`);
      if (options.throwCompare) throw new Error('comparison consumer failed');
      return options.incomparable ? { directlyComparable: false, mismatches: ['metricDefinitions'] }
        : { directlyComparable: true, mismatches: [], profileExperiment: false, deltas: { g2: {}, g3: {} } }; },
  };
  return { root, scratch, durable, calls, hooks, get runs() { return runs; } };
}

async function campaign(f, options = {}) {
  return runCampaign({ root: f.root, hooks: f.hooks, campaignId: 'campaign-test-12345678', ...options });
}

test('campaign resumes its own FULL checkpoint, preserves accepted reports and promotes only N/N',async t=>{
  const f=await fixture(t,{plannedRuns:3,pauseRun:2});
  const stopped=await campaign(f);assert.equal(stopped.status,'FOCAL_STOP');assert.equal(stopped.completedRuns,1);
  assert.equal(f.runs,2);assert.equal(await fs.stat(f.durable).then(()=>true,()=>false),false);
  const root=path.join(f.scratch,'campaign-test-12345678'),stateFile=path.join(root,'state.json');
  const stateBytes=await fs.readFile(stateFile),state=JSON.parse(stateBytes),accepted=await fs.readFile(path.join(root,'run-01.json'));
  const attempts=()=>f.calls.filter(s=>/^run-|^resume-/u.test(s)).length;
  const preflight=f.hooks.preflightFullResume;
  for(const cause of ['uncertain ledger','denied case','altered evidence']){
    f.hooks.preflightFullResume=async()=>{throw Error(cause);};const before=attempts();
    try{await assert.rejects(campaign(f,{resumeId:stopped.campaignId}),new RegExp(cause));
      assert.equal(attempts(),before);assert.deepEqual(await fs.readFile(stateFile),stateBytes,'controller refusal precedes ACTIVE');
    }finally{f.hooks.preflightFullResume=preflight;}
  }
  for(const change of [x=>{x.freeze.plannedRuns=2;},x=>{x.freeze.head='foreign';},
    x=>{x.pendingCheckpoint='sha256:'+'0'.repeat(64);},x=>{x.completed[0].reportSha256='foreign';},
    x=>{delete x.freeze;}]){
    const bad=structuredClone(state);change(bad);
    // Reseal to exercise the authoritative bindings, not only a checksum.
    const {stateSha256,...body}=bad;bad.stateSha256='sha256:'+(await import('node:crypto')).createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const bytes=Buffer.from(JSON.stringify(bad));await fs.writeFile(stateFile,bytes);const before=attempts();
    try{await assert.rejects(campaign(f,{resumeId:stopped.campaignId}));assert.equal(attempts(),before);
      assert.deepEqual(await fs.readFile(stateFile),bytes,'bad resume never rewrites original state');
    }finally{await fs.writeFile(stateFile,stateBytes);}
  }
  const result=await campaign(f,{resumeId:stopped.campaignId});assert.equal(result.completedRuns,3);assert.equal(result.status,'CAMPAIGN_COMPLETE');
  assert.equal(f.runs,3);assert.equal(f.calls.filter(x=>x==='resume-run-fixture-2').length,1);
  assert.deepEqual(await fs.readFile(path.join(root,'run-01.json')),accepted);
  assert.deepEqual(await fs.readFile(path.join(f.durable,'run-01.json')),accepted);
  const before=attempts();await assert.rejects(campaign(f,{resumeId:stopped.campaignId}));assert.equal(attempts(),before);
});

for (const runs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
  test(`invalid run count ${String(runs)} is rejected before hooks/files/dispatch`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-invalid-count-'));
    t.after(() => process.env.STNL_OFFLINE_KEEP_FIXTURES==='1'?undefined:fs.rm(root, { recursive: true, force: true }));
    let calls = 0;
    const forbidden = () => { calls += 1; throw new Error('unexpected campaign effect'); };
    await assert.rejects(runCampaign({ root, runs, hooks: { gitState: forbidden, processes: forbidden, verify: forbidden, runFull: forbidden } }), /positive integer/u);
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(root), []);
  });
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
  assert.equal(await fs.readFile(path.join(f.scratch, '.turn-ledger.json'), 'utf8'), '{}', 'starting a campaign preserves preexisting ledgers');
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
  const f = await fixture(t, { blockRun: 1, plannedRuns: 3 });
  await assert.rejects(campaign(f), /FIXTURE_BLOCKER/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
  assert.equal((await fs.readdir(f.scratch)).includes('run-fixture-1'), true);
});

test('two samples have an even median and partial coverage remains unavailable', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE), 'utf8'));
  const reports = [structuredClone(baseline), structuredClone(baseline)];
  reports[1].run.id = 'run-statistics-second';
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

test('incompatible comparison does not fabricate deltas or block independent quality', async (t) => {
  const f = await fixture(t, { incomparable: true });
  const result = await campaign(f);
  assert.equal(f.runs, 1);
  assert.equal(result.status, 'CAMPAIGN_COMPLETE');
  assert.equal(result.comparability, 'unavailable');
  assert.deepEqual(result.runs[0].comparisonToBaseline.mismatches, ['metricDefinitions']);
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
  const f = await fixture(t, { cancelRun: 1, plannedRuns: 3 });
  await assert.rejects(campaign(f), /campaign interrupted/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
  const state = JSON.parse(await fs.readFile(path.join(f.scratch, 'campaign-test-12345678/state.json'), 'utf8'));
  assert.equal(state.status, 'CANCELLED');
});

test('source drift after run 1 blocks before run 2', async (t) => {
  const f = await fixture(t, { sourceDrift: true, plannedRuns: 3 });
  await assert.rejects(campaign(f), /functional source changed/u);
  assert.equal(f.runs, 1);
  assert.equal(await fs.stat(f.durable).then(() => true, () => false), false);
});

test('npm benchmark and formal campaign expose default N without dispatch from help', async () => {
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
  assert.match(result.stdout, /Functional 3-full campaign: npm run benchmark/u);
  assert.match(result.stdout, /Formal 3-full campaign: npm run benchmark:campaign/u);
});

async function functionalFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-functional-test-'));
  t.after(() => process.env.STNL_OFFLINE_KEEP_FIXTURES==='1'?undefined:fs.rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'benchmark-temp');
  const measurements = path.join(root, 'benchmarks/sentinel-todo/measurements');
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, MANIFEST), 'utf8'));
  manifest.campaign.fullRuns = options.plannedRuns ?? 1;
  await fs.mkdir(path.dirname(path.join(root, MANIFEST)), { recursive: true });
  await fs.writeFile(path.join(root, MANIFEST), JSON.stringify(manifest));
  const calls = []; let runs = 0;
  const hooks = {
    verify: async () => { calls.push('verify'); return { code: 0 }; },
    processes: () => [],
    runFull: async () => {
      runs += 1; calls.push(`run-${runs}`);
      const id = `run-functional-${runs}`; const runRoot = path.join(scratch, id);
      await fs.mkdir(runRoot, { recursive: true });
      await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
      const status = options.blockRun === runs ? 'BLOCKED' : options.status ?? 'PASS';
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
      const report = currentFixtureReport(baseline, manifest, id);
      report.run.status = options.blockRun === runs ? 'BLOCKED' : options.status ?? 'PASS';
      if (report.run.status !== 'PASS') {
        report.cases[0].status = report.run.status;
        for (const row of report.cases.slice(1)) row.status = 'NOT_RUN';
      }
      return report;
    },
    cleanRun: async (id) => { calls.push(`clean-${id}`); await fs.rm(path.join(scratch, id), { recursive: true }); return { code: 0 }; },
  };
  return { root, scratch, measurements, baseline, manifest, calls, hooks, get runs() { return runs; } };
}

test('functional unqualified campaign leaves official history unchanged, including earlier passing FULL',async t=>{
  const f=await functionalFixture(t,{plannedRuns:3,blockRun:2});
  await fs.mkdir(f.measurements,{recursive:true});await fs.writeFile(path.join(f.measurements,'historical.json'),'unchanged historical bytes\n');
  await assert.rejects(runFunctionalBenchmark({root:f.root,hooks:f.hooks}));
  assert.deepEqual(await fs.readdir(f.measurements),['historical.json']);
  assert.equal(await fs.readFile(path.join(f.measurements,'historical.json'),'utf8'),'unchanged historical bytes\n');
  const campaigns=(await fs.readdir(f.scratch)).filter(name=>name.startsWith('campaign-'));
  assert.ok((await fs.stat(path.join(f.scratch,campaigns[0],'run-01.json'))).isFile());
  assert.ok((await fs.stat(path.join(f.scratch,campaigns[0],'run-02.json'))).isFile());
  assert.equal(f.runs,2);
});

test('functional qualified campaign promotes the complete existing summary only after all FULLs',async t=>{
  const f=await functionalFixture(t,{plannedRuns:3}),run=f.hooks.runFull;
  await fs.mkdir(f.measurements,{recursive:true});await fs.writeFile(path.join(f.measurements,'latest.json'),'legacy latest bytes\n');
  f.hooks.runFull=async(...args)=>{
    assert.deepEqual(await fs.readdir(f.measurements),['latest.json']);
    return run(...args);
  };
  const result=await runFunctionalBenchmark({root:f.root,hooks:f.hooks});
  assert.equal(await fs.readFile(path.join(f.measurements,'latest.json'),'utf8'),'legacy latest bytes\n');
  const dirs=(await fs.readdir(f.measurements)).filter(name=>name!=='latest.json');assert.equal(dirs.length,1);
  assert.equal(result.measurements,path.join(f.measurements,dirs[0]));
  const summary=JSON.parse(await fs.readFile(path.join(result.measurements,'campaign-summary.json')));
  assert.equal(summary.completedRuns,3);
  for(const n of ['01','02','03'])assert.ok((await fs.stat(path.join(result.measurements,`run-${n}.json`))).isFile());
});

test('functional PASS without required qualification proof never reaches history',async t=>{
 const f=await functionalFixture(t,{plannedRuns:3}),exported=f.hooks.exportMeasurement;
 f.hooks.exportMeasurement=async(...args)=>{const report=await exported(...args);delete report.cases[2].productAcceptance;return report;};
 await assert.rejects(runFunctionalBenchmark({root:f.root,hooks:f.hooks}),/productAcceptance/u);
 assert.equal(f.runs,1);await assert.rejects(fs.lstat(f.measurements),{code:'ENOENT'});
 assert.ok((await fs.stat(path.join(f.scratch,'run-functional-1'))).isDirectory());
});

test('functional mode handles absent scratch and retains terminal history across invocations', async (t) => {
  const f = await functionalFixture(t);
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  await fs.writeFile(path.join(f.scratch, '.campaign-state.json'), JSON.stringify({ status: 'BLOCKED' }));
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.equal(f.runs, 2);
  assert.ok(!f.calls.some(call => call.startsWith('clean-')));
  const directories=await fs.readdir(f.measurements);assert.equal(directories.length,2);
  const summaries=await Promise.all(directories.map(name=>fs.readFile(path.join(f.measurements,name,'campaign-summary.json'),'utf8').then(JSON.parse)));
  assert.deepEqual(summaries.flatMap(x=>x.runs.map(r=>r.runId)).sort(),['run-functional-1','run-functional-2']);
  await assert.rejects(fs.lstat(path.join(f.measurements,'latest.json')),{code:'ENOENT'});
  assert.equal(await fs.stat(path.join(f.scratch, 'run-functional-1')).then(() => true, () => false), true);
  assert.equal(await fs.stat(path.join(f.scratch, 'run-functional-2')).then(() => true, () => false), true);
  assert.equal((await fs.readdir(f.scratch)).some((name) => name.startsWith('run-')), true);
  assert.equal((await fs.readdir(f.scratch)).includes('.campaign-state.json'), true);
});

for (const [name, mode, caseId, status, uncreated] of [
  ['individual A PASS', 'case', 'A', 'PASS', false],
  ['individual B PASS', 'case', 'B', 'PASS', false],
  ['terminal focal', 'focal', 'A', 'FOCAL_STOP', false],
  ['zero-turn startup failure', 'full', 'A', 'BLOCKED', true],
]) test(`functional start preserves ${name} without adopting or deleting its evidence`, async (t) => {
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
  assert.equal(await fs.stat(dir).then(() => true, () => false), true);
  assert.ok(!f.calls.includes(`clean-${id}`));
  assert.ok(!f.calls.includes(`export-${id}`));
  await assert.rejects(fs.lstat(path.join(f.measurements, `${id}.json`)), { code: 'ENOENT' });
});

test('functional cleanup rejects activity, identity ambiguity and unsafe home evidence before dispatch', async (t) => {
  for (const variant of ['process', 'active-marker', 'ownership', 'run-id', 'summary-mode', 'case-id', 'active-case',
    'missing-case', 'missing-creation-record', 'partial-home', 'nonzero-turn', 'nonempty-journal']) {
    await t.test(variant, async (child) => {
      const f = await functionalFixture(child);
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

test('functional mode retains an old campaign without re-publishing or deleting its report', async (t) => {
  const f = await functionalFixture(t);
  const campaignRoot = path.join(f.scratch, 'campaign-old-12345678');
  await fs.mkdir(campaignRoot, { recursive: true });
  await fs.writeFile(path.join(campaignRoot, '.sentinel-campaign-owned'), 'sentinel-todo-campaign-v1\n');
  await fs.writeFile(path.join(campaignRoot, 'state.json'), JSON.stringify({ status: 'BLOCKED' }));
  const oldReport = currentFixtureReport(f.baseline, f.manifest, 'run-old-12345678');
  await fs.writeFile(path.join(campaignRoot, 'run-01.json'), JSON.stringify(oldReport));
  await runFunctionalBenchmark({ root: f.root, hooks: f.hooks });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(campaignRoot, 'run-01.json'), 'utf8')), oldReport);
  assert.equal(await fs.stat(campaignRoot).then(() => true, () => false), true);
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
  await assert.rejects(fs.lstat(path.join(f.measurements, `${oldReport.run.id}.json`)), { code: 'ENOENT' });
  assert.equal((await fs.stat(campaignRoot)).isDirectory(), true);
});

test('current functional result cannot silently succeed with a case report', async t => {
  const f = await functionalFixture(t);
  const exported = f.hooks.exportMeasurement;
  f.hooks.exportMeasurement = async id => ({ ...await exported(id), run: { ...f.baseline.run, id, mode: 'case' } });
  await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }), /current benchmark report must be full/);
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

for(const status of ['BLOCKED','PAUSED_BUDGET_OR_QUOTA','CANCELLED'])test(`functional ${status} is retained only as diagnosis`,async t=>{
  const f=await functionalFixture(t,{status,cancelRun:status==='CANCELLED'});
  await assert.rejects(runFunctionalBenchmark({root:f.root,hooks:f.hooks}),new RegExp(`outcome ${status}`));
  await assert.rejects(fs.lstat(f.measurements),{code:'ENOENT'});
  assert.ok((await fs.stat(path.join(f.scratch,'run-functional-1'))).isDirectory());
  const dirs=(await fs.readdir(f.scratch)).filter(name=>name.startsWith('campaign-'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.scratch,dirs[0],'run-01.json'))).run.status,status);
});

test('failure before run creation preserves qualified history without inventing a measurement',async t=>{
 const f=await functionalFixture(t),accepted=await runFunctionalBenchmark({root:f.root,hooks:f.hooks});
 const files=await fs.readdir(accepted.measurements);const summary=await fs.readFile(path.join(accepted.measurements,'campaign-summary.json'));
 f.hooks.runFull=async()=>({code:1});
 await assert.rejects(runFunctionalBenchmark({root:f.root,hooks:f.hooks}),/created 0 run directories/u);
 assert.deepEqual(await fs.readdir(accepted.measurements),files);assert.deepEqual(await fs.readFile(path.join(accepted.measurements,'campaign-summary.json')),summary);
 assert.equal((await fs.readdir(f.measurements)).length,1);
});

for (const mode of ['formal', 'functional']) {
  test(`${mode} N=3 and override N=2 sequence exactly N qualifying FULLs`, async t => {
    const create = mode === 'formal' ? fixture : functionalFixture;
    for (const override of [undefined, 2]) {
      const f = await create(t, { plannedRuns: 3 });
      const runFull = f.hooks.runFull;
      f.hooks.runFull = async (...args) => {
        if (mode === 'functional') await assert.rejects(fs.lstat(path.join(f.measurements, 'latest.json')), { code: 'ENOENT' });
        return runFull(...args);
      };
      const result = mode === 'formal' ? await campaign(f, { runs: override })
        : await runFunctionalBenchmark({ root: f.root, hooks: f.hooks, runs: override });
      assert.equal(f.runs, override ?? 3);
      assert.equal(result.plannedRuns, override ?? 3);
      assert.equal(result.completedRuns, override ?? 3);
      if (mode === 'functional') {
        assert.equal((await fs.readdir(f.measurements)).length,1);
        assert.ok(result.measurements.startsWith(f.measurements+path.sep));
        const dirs = (await fs.readdir(f.scratch)).filter(name => name.startsWith('campaign-'));
        const summary = JSON.parse(await fs.readFile(path.join(f.scratch, dirs[0], 'campaign-summary.json')));
        assert.equal(summary.completedRuns, override ?? 3);
        assert.equal(summary.comparability, 'unavailable');
      }
    }
  });
}

test('repository default is N=3 and CLI override is parsed before dispatch', () => {
  assert.deepEqual(parseCampaignArgs([]), { mode: 'campaign' });
  assert.deepEqual(parseCampaignArgs(['--functional']), { mode: 'functional' });
  assert.deepEqual(parseCampaignArgs(['--runs', '2']), { mode: 'campaign', runs: 2 });
  assert.deepEqual(parseCampaignArgs(['--functional', '--runs', '1']), { mode: 'functional', runs: 1 });
});

for (const argv of [['--runs'], ['--runs', '0'], ['--runs', '-1'], ['--runs', '1.5'], ['--runs', 'Infinity'],
  ['--runs', '9007199254740992'], ['--runs', '2', '--runs', '3'], ['--unknown'],
  ['--functional', '--functional'], ['--functional', '--runs', '2', '--runs', '1']]) {
  test(`invalid CLI ${argv.join(' ')} has no files or dispatch effects`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-campaign-cli-'));
    t.after(() => process.env.STNL_OFFLINE_KEEP_FIXTURES==='1'?undefined:fs.rm(root, { recursive: true, force: true }));
    assert.throws(() => parseCampaignArgs(argv), /usage:/u);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs'), ...argv], {
      cwd: root, env: testEnvironment(), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /BLOCKED_CONFIG/u);
    assert.deepEqual(await fs.readdir(root), []);
  });
}

function testEnvironment() { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; }

for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
  test(`functional invalid N=${String(count)} is rejected before any hook or file`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-functional-count-'));
    t.after(() => process.env.STNL_OFFLINE_KEEP_FIXTURES==='1'?undefined:fs.rm(root, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(runFunctionalBenchmark({ root, runs: count, hooks: {
      verify: () => { calls++; throw new Error('unexpected dispatch'); }, runFull: () => { calls++; },
    } }), /positive integer/u);
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(root), []);
  });
}

for (const variant of ['absent', 'malformed', 'old-profile', 'old-version']) {
  test(`formal quality N/N is independent of ${variant} baseline`, async t => {
    const f = await fixture(t, { plannedRuns: 3, historicalBaseline: variant === 'old-profile' });
    const file = path.join(f.root, BASELINE);
    if (variant === 'absent') await fs.unlink(file);
    if (variant === 'malformed') await fs.writeFile(file, '{');
    if (variant === 'old-version') { const value = JSON.parse(await fs.readFile(file)); value.benchmarkVersion = 0; await fs.writeFile(file, JSON.stringify(value)); }
    const result = await campaign(f);
    assert.equal(f.runs, 3);
    assert.equal(result.status, 'CAMPAIGN_COMPLETE');
    assert.equal(result.comparability, 'unavailable');
    assert.ok(result.runs.every(row => row.comparisonToBaseline.deltas === 'unavailable'));
    assert.ok(!f.calls.some(call => call.startsWith('compare-')), 'incompatible baseline does not fabricate deltas');
  });
}

test('unexpected comparator failure stops the formal campaign and retains its report', async t => {
  const f = await fixture(t, { plannedRuns: 3, throwCompare: true });
  await assert.rejects(campaign(f), /comparison consumer failed/u);
  assert.equal(f.runs, 1);
  assert.equal((await fs.stat(path.join(f.scratch, 'campaign-test-12345678/run-01.json'))).isFile(), true);
  await assert.rejects(fs.lstat(f.durable), { code: 'ENOENT' });
});

test('formal campaign rejects unqualified current case before comparison or the next FULL', async t => {
  const f = await fixture(t, { plannedRuns: 3, unqualifiedCase: 'C' });
  await assert.rejects(campaign(f), /productAcceptance/u);
  assert.equal(f.runs, 1);
  assert.ok(!f.calls.some(call => call.startsWith('compare-')));
  await assert.rejects(fs.lstat(f.durable), { code: 'ENOENT' });
});

for (const failure of ['second-run', 'publish', 'activity', 'identity']) {
  test(`functional ${failure} stops before remaining FULLs without promoting or deleting history`, async t => {
    const f = await functionalFixture(t, { plannedRuns: 3, blockRun: failure === 'second-run' ? 2 : undefined });
    if(failure==='publish'){
      const copy=fs.copyFile.bind(fs);t.mock.method(fs,'copyFile',async(from,to,...args)=>{
        if(to.includes('-stage'+path.sep))throw new Error('fixture promotion failure');return copy(from,to,...args);
      });
    }
    if (failure === 'activity') {
      let active = false; const exported = f.hooks.exportMeasurement;
      f.hooks.exportMeasurement = async (...args) => { const value = await exported(...args); active = true; return value; };
      f.hooks.processes = () => active ? ['fixture active benchmark'] : [];
    }
    if (failure === 'identity') {
      const exportReport = f.hooks.exportMeasurement;
      f.hooks.exportMeasurement = async (...args) => { const report = await exportReport(...args); report.run.id = 'run-foreign'; return report; };
    }
    await assert.rejects(runFunctionalBenchmark({ root: f.root, hooks: f.hooks }));
    assert.equal(f.runs, failure==='publish'?3:failure==='second-run'?2:1);
    await assert.rejects(fs.lstat(path.join(f.measurements, 'latest.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.measurements).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error)),[]);
    assert.equal((await fs.stat(path.join(f.scratch, 'run-functional-1'))).isDirectory(), true);
    assert.ok(!f.calls.some(call => call.startsWith('clean-')));
  });
}

for (const variant of ['failed-run', 'failed-case', 'missing-case', 'duplicate-run', 'source-drift', 'profile-drift']) {
  test(`summary refuses ${variant} instead of manufacturing N/N PASS`, async () => {
    const baseline = JSON.parse(await fs.readFile(path.join(ROOT, BASELINE)));
    const reports = [structuredClone(baseline), structuredClone(baseline)];
    reports[1].run.id = 'run-summary-second';
    if (variant === 'failed-run') reports[1].run.status = 'BLOCKED';
    if (variant === 'failed-case') reports[1].cases[2].status = 'NOT_RUN';
    if (variant === 'missing-case') reports[1].cases.pop();
    if (variant === 'duplicate-run') reports[1].run.id = reports[0].run.id;
    if (variant === 'source-drift') reports[1].provenance.sourceFunctionalSha256 = 'different';
    if (variant === 'profile-drift') reports[1].run.profile = 'different';
    assert.throws(() => campaignSummary({ campaignId: 'campaign-summary-negative', reports, comparisons: [{}, {}], plannedRuns: 2 }), /distinct coherent passing FULLs/u);
  });
}
