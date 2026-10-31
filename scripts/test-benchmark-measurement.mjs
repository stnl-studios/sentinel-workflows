import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareMeasurements, exportMeasurement, publishMeasurement, validateMeasurementReport } from '../benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs';
import { currentFunctionalIdentity } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';
import { runFunctionalBenchmark } from '../benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs';
import { productInstrumentIdentity, productCandidateIdentity, PRODUCT_CONTRACT, PRODUCT_CHECK_IDS } from '../benchmarks/sentinel-todo/runtime/product-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs');
const benchmarkDir = path.join(root, 'benchmarks/sentinel-todo');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-measurement-'));
const runId = `run-measurement-${process.pid}`;
const benchmarkTempRoot = path.join(root, 'benchmark-temp');
const hadBenchmarkTemp = await fs.stat(benchmarkTempRoot).then(() => true, () => false);
const runRoot = path.join(benchmarkTempRoot, runId);
const snapshotRoot = path.join(runRoot, 'snapshot');
const UNAVAILABLE = 'unavailable';

async function filesUnder(dir, relative = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(dir, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(dir, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function digestFiles(dir, files) {
  const hash = createHash('sha256').update('sentinel-functional-snapshot-v1\0');
  for (const rel of [...files].sort()) {
    const bytes = await fs.readFile(path.join(dir, rel));
    hash.update(rel.split(path.sep).join('/')).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function makeFixture() {
  await fs.mkdir(path.join(root, 'benchmark-temp'), { recursive: true });
  await fs.mkdir(path.join(runRoot, 'case-a'), { recursive: true });
  await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  for (const dir of ['skills', 'agents', 'templates', 'scripts', 'benchmarks/sentinel-todo/schemas', 'benchmarks/sentinel-todo/measurements']) await fs.mkdir(path.join(snapshotRoot, dir), { recursive: true });
  await fs.writeFile(path.join(snapshotRoot, 'benchmarks/sentinel-todo/measurements/legacy.json'), '{"legacy":true}\n');
  await fs.copyFile(path.join(benchmarkDir, 'benchmark.json'), path.join(snapshotRoot, 'benchmarks/sentinel-todo/benchmark.json'));
  await fs.copyFile(path.join(benchmarkDir, 'schemas/result-v2.schema.json'), path.join(snapshotRoot, 'benchmarks/sentinel-todo/schemas/result-v2.schema.json'));
  const instrumentRoot = path.join(snapshotRoot, 'benchmarks/sentinel-todo/runtime');
  await fs.mkdir(instrumentRoot, { recursive: true });
  for (const file of ['product-acceptance.mjs', 'product-write-observer.cjs']) {
    await fs.copyFile(path.join(benchmarkDir, 'runtime', file), path.join(instrumentRoot, file));
  }
  const sources = [];
  for (const prefix of ['skills', 'agents', 'templates', 'scripts', 'benchmarks/sentinel-todo']) sources.push(...(await filesUnder(snapshotRoot, prefix)));
  const allFiles = await filesUnder(snapshotRoot);
  const config = JSON.parse(await fs.readFile(path.join(snapshotRoot, 'benchmarks/sentinel-todo/benchmark.json'), 'utf8'));
  const meta = { protocol: 'sentinel-sdk-context-v1', baseSha: 'fixture-base', dirty: false, functionalDiffSha256: 'sha256:fixture-diff',
    sourceFunctionalSha256: await digestFiles(snapshotRoot, sources), sourceFileCount: sources.length,
    snapshotSha256: await digestFiles(snapshotRoot, allFiles), snapshotFileCount: allFiles.length, createdAt: '2026-01-01T00:00:00.000Z' };
  await fs.writeFile(path.join(runRoot, 'snapshot.json'), `${JSON.stringify(meta)}\n`);
  const now = '2026-01-01T00:00:00.000Z';
  const workspace = path.join(runRoot, 'case-a/workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'TEST-ONLY-candidate.txt'), 'synthetic validator candidate\n');
  const product = { root: workspace, sha256: await productCandidateIdentity(workspace) };
  const evidence = { operation: 'SPEC_INIT', turn: { usageObservation: { status: 'attributable', source: 'main', eventId: 'fixture-main', delta:
    { input: 100, output: 20, cachedInput: 10, reasoningOutput: 5 } } } };
  await fs.writeFile(path.join(runRoot, 'case-a/01-spec_init.json'), JSON.stringify(evidence));
  const raw = { status: 'PASS', finalExecutionState: 'COMPLETE', specClosed: true, finalTestsPassed: true,
    workspace: { productRoot: product.root, productSha256: product.sha256 },
    // Synthetic validator fixture, not an execution/qualification artifact.
    productAcceptance: { contract: PRODUCT_CONTRACT, instrumentSha256: productInstrumentIdentity(), product, caseId: 'A',
      passed: true, checks: [...PRODUCT_CHECK_IDS.A], commands: 1, failedCheck: null, diagnostic: null, errorCode: null },
    decomposition: { slices: 0 }, operations: { findingsCycles: 0 } };
  await fs.writeFile(path.join(runRoot, 'case-a/raw.json'), JSON.stringify(raw));
  await fs.writeFile(path.join(runRoot, 'case-a/case-state.json'), JSON.stringify({ caseId: 'A', workspace, status: 'PASS', startedAt: now, endedAt: now,
    mainTurns: 1, runnerTurns: 0, finalizer: { exitCode: 0 }, operations: [{ evidencePath: '01-spec_init.json' }] }));
  await fs.writeFile(path.join(runRoot, 'case-a/journal.json'), JSON.stringify({ events: [{ operation: 'SPEC_INIT', slice: null, childDispatches: [], durationMs: 0 }] }));
  for (const id of ['B', 'C']) {
    const dir = path.join(runRoot, `case-${id.toLowerCase()}`), selected = path.join(dir, 'workspace');
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, 'TEST-ONLY-candidate.txt'), `synthetic ${id}\n`);
    const binding = { root: selected, sha256: await productCandidateIdentity(selected) };
    await fs.writeFile(path.join(dir, 'raw.json'), JSON.stringify({ ...raw,
      workspace: { productRoot: binding.root, productSha256: binding.sha256 },
      productAcceptance: { ...raw.productAcceptance, caseId: id, product: binding, checks: [...PRODUCT_CHECK_IDS[id]] } }));
    await fs.writeFile(path.join(dir, 'case-state.json'), JSON.stringify({ caseId: id, workspace: selected, status: 'PASS', startedAt: now, endedAt: now,
      mainTurns: 0, runnerTurns: 0, finalizer: { exitCode: 0 }, operations: [] }));
    await fs.writeFile(path.join(dir, 'journal.json'), JSON.stringify({ events: [] }));
  }
  const run = { runId, status: 'PASS', mode: 'full', cases: ['A', 'B', 'C'], profile: 'production-v2', startedAt: now, endedAt: now,
    snapshot: { sourceFunctionalSha256: meta.sourceFunctionalSha256, snapshotSha256: meta.snapshotSha256 } };
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runId, status: 'PASS', mode: 'full', cases: {
    A: { caseId: 'A', status: 'PASS', operations: 1, mainTurns: 1, runnerTurns: 0 },
    B: { caseId: 'B', status: 'PASS', operations: 0, mainTurns: 0, runnerTurns: 0 },
    C: { caseId: 'C', status: 'PASS', operations: 0, mainTurns: 0, runnerTurns: 0 } } }));
}

try {
  const baseline = JSON.parse(await fs.readFile(path.join(benchmarkDir, 'baselines/baseline-v1.json'), 'utf8'));
  validateMeasurementReport(baseline);
  assert.throws(() => validateMeasurementReport(baseline, { qualify: true }), /productAcceptance/u,
    'historical baseline remains readable, but cannot invent current product evidence');
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.baselineVersion, 1);
  assert.equal(baseline.baselineIdentity.functionalCheckpoint, '1a6195816b78f50c686b36143460b26f157baed6');
  assert.equal(baseline.baselineIdentity.currentHygieneCheckpoint, '3a40958dac6edc8ff28c76b72170611ee3983e05');
  assert.equal(baseline.run.id, 'run-20260927034729-712b2b42');
  assert.deepEqual(baseline.cases.map((c) => [c.id, c.status, c.operations, c.mainTurns, c.runnerTurns]), [
    ['A', 'PASS', 12, 12, 6], ['B', 'PASS', 12, 12, 6], ['C', 'PASS', 12, 12, 7],
  ]);
  assert.equal(baseline.aggregate.extraRunnerTurns, 1);
  assert.deepEqual(baseline.cases.map((c) => c.operationDurations.length), [12, 12, 12]);
  assert.equal(baseline.aggregate.telemetry.coverage.main, '36/36');
  assert.equal(baseline.aggregate.telemetry.coverage.runner, '19/19');
  assert.equal(baseline.aggregate.telemetry.main.input, 42877945);
  assert.equal(baseline.aggregate.telemetry.runner.input, 2110337);
  assert.equal(baseline.aggregate.telemetry.main.cachedInput, 40784000);
  assert.equal(baseline.aggregate.telemetry.main.reasoningOutput, 79444);
  assert.deepEqual(baseline.cases.map((c) => [c.provider, c.authMode, c.isolation, c.finalTestsPassed, c.profileMismatches]),
    Array.from({ length: 3 }, () => ['openai', 'chatgpt', 'restricted', true, []]));
  const baselineCore = structuredClone(baseline); delete baselineCore.baselineIdentity; delete baselineCore.baselineVersion;
  await makeFixture();
  const rawPath = path.join(runRoot, 'case-a/raw.json');
  const initialRaw = await fs.readFile(rawPath);
  const rawHash = createHash('sha256').update(initialRaw).digest('hex');
  const first = path.join(temp, 'first.json'); const second = path.join(temp, 'second.json');
  execFileSync(process.execPath, [cli, 'export', '--run', runId, '--output', first], { cwd: root });
  execFileSync(process.execPath, [cli, 'export', '--run', runId, '--output', second], { cwd: root });
  assert.equal(await fs.readFile(first, 'utf8'), await fs.readFile(second, 'utf8'), 'report bytes must be deterministic');
  const report = JSON.parse(await fs.readFile(first, 'utf8'));
  validateMeasurementReport(report);
  assert.equal(report.measurement.status, 'complete');
  const nativeReport = structuredClone(report); delete nativeReport.measurement;
  nativeReport.provenance.runtimeVersions = { sdk: '0.163.0', cli: '0.163.0' };
  nativeReport.cases[0].provider = 'app-server-0.163.0';
  nativeReport.cases[0].childRuntimeConfiguration = [];
  nativeReport.cases[0].runtimeConfiguration = [{ operation: 'SPEC_INIT', requestedModel: 'gpt-6.1-sol', requestedEffort: 'medium',
    acknowledged: { model: 'gpt-6.1-sol', serviceTier: 'unspecified', approvalPolicy: 'on-request', legacySandboxType: 'workspaceWrite', requestedEffort: 'medium' } }];
  validateMeasurementReport(nativeReport, { qualify: true });
  for (const key of ['model','serviceTier','approvalPolicy','legacySandboxType','requestedEffort','all']) {
    const broken = structuredClone(nativeReport);
    if (key === 'all') broken.cases[0].runtimeConfiguration[0].acknowledged = {};
    else delete broken.cases[0].runtimeConfiguration[0].acknowledged[key];
    assert.throws(() => validateMeasurementReport(broken, { qualify: true }), /measurement incomplete/u, `missing ACK ${key}`);
  }
  for (const field of ['model','serviceTier','approvalPolicy','legacySandboxType']) {
    const different = structuredClone(nativeReport);
    different.cases[0].runtimeConfiguration[0].acknowledged[field] = { model: 'gpt-6-luna', serviceTier: 'fast',
      approvalPolicy: 'never', legacySandboxType: 'dangerFullAccess' }[field];
    assert.equal(compareMeasurements(nativeReport, different).directlyComparable, false, `changed observed ${field} cannot silently compare`);
  }
  for (const value of [null, {}, { ...nativeReport.cases[0].runtimeConfiguration[0], operation: null }]) {
    const broken=structuredClone(nativeReport);broken.cases[0].runtimeConfiguration=[value];
    assert.throws(()=>validateMeasurementReport(broken,{qualify:true}),/measurement incomplete/u);
    assert.equal(compareMeasurements(broken,broken).directlyComparable,false,'corrupt ACK remains a diagnostic, never a TypeError or PASS');
  }
  const childReport=structuredClone(nativeReport);
  childReport.cases[0].runnerTurns=1;childReport.aggregate.runnerTurns=1;
  childReport.cases[0].telemetry.runner=structuredClone(childReport.cases[0].telemetry.main);
  childReport.aggregate.telemetry.runner=structuredClone(childReport.aggregate.telemetry.main);
  childReport.cases[0].telemetry.coverage.runner='1/1';childReport.aggregate.telemetry.coverage.runner='1/1';
  childReport.cases[0].childRuntimeConfiguration=[{operation:'SPEC_INIT',model:'gpt-6-luna',effort:'medium'}];
  validateMeasurementReport(childReport,{qualify:true});
  for(const value of [null,{}, {model:'gpt-6-luna',effort:'medium'}, {operation:'FOREIGN',model:'gpt-6-luna',effort:'medium'}]) {
    const broken=structuredClone(childReport);broken.cases[0].childRuntimeConfiguration=[value];
    assert.throws(()=>validateMeasurementReport(broken,{qualify:true}),/measurement incomplete/u);
    assert.equal(compareMeasurements(broken,broken).directlyComparable,false);
  }
  const changedChild=structuredClone(childReport);changedChild.cases[0].childRuntimeConfiguration[0].model='gpt-6.1-sol';
  assert.equal(compareMeasurements(childReport,changedChild).directlyComparable,false,'observed child model affects comparability');
  const versionChange = structuredClone(nativeReport); versionChange.provenance.runtimeVersions.cli = '0.164.0';
  assert.equal(compareMeasurements(nativeReport, versionChange).directlyComparable, false);
  for (const role of ['main', 'runner']) {
    const missing = structuredClone(report);
    delete missing.measurement;
    if (role === 'runner') {
      missing.cases[0].runnerTurns = 1;
      missing.aggregate.runnerTurns = 1;
    }
    missing.cases[0].telemetry[role] = UNAVAILABLE;
    missing.cases[0].telemetry.coverage[role] = '0/1';
    missing.aggregate.telemetry[role] = UNAVAILABLE;
    missing.aggregate.telemetry.coverage[role] = '0/1';
    validateMeasurementReport(missing); // Diagnostic evidence remains readable.
    assert.throws(() => validateMeasurementReport(missing, { qualify: true }),
      /measurement incomplete/u, `functional PASS must not qualify without ${role} consumption`);
  }
  for (const [name, mutate] of [
    ['missing phase time', value => { value.cases[0].operationDurations[0].durationMs = UNAVAILABLE; }],
    ['case time cannot replace wall time', value => { value.aggregate.wallDurationMs += 1; }],
    ['negative usage', value => { value.cases[0].telemetry.main.input = -1; }],
    ['cached input is a subset', value => { value.cases[0].telemetry.main.cachedInput = 101; }],
    ['foreign aggregate', value => { value.aggregate.telemetry.main.input += 1; }],
    ['missing case', value => { value.cases.pop(); }],
  ]) {
    const invalid = structuredClone(report); delete invalid.measurement; mutate(invalid);
    assert.throws(() => validateMeasurementReport(invalid, { qualify: true }), /measurement incomplete|complete passing case scope/u, name);
  }
  const reordered = structuredClone(report); reordered.measurement = { missing: [], status: 'complete' };
  validateMeasurementReport(reordered, { qualify: true });
  const official=path.join(root,'benchmarks/sentinel-todo/measurements');
  await fs.mkdir(official,{recursive:true});
  const historyBefore=await fs.readdir(official);
  await assert.rejects(publishMeasurement(report),/explicit temporary report destination/u);
  for(const status of ['PASS','BLOCKED']) {
    const candidate=structuredClone(report);candidate.run.status=status;
    await assert.rejects(publishMeasurement(candidate,{root:official}),/qualified campaign promotion/u);
    await assert.rejects(publishMeasurement(candidate,{root:path.join(official,'nested')}),/qualified campaign promotion/u);
  }
  const alias=path.join(temp,'history-alias');await fs.symlink(official,alias,'dir');
  await assert.rejects(publishMeasurement(report,{root:alias}),/qualified campaign promotion/u);
  for(const output of [path.join(official,'unqualified.json'),path.join(alias,'unqualified.json')]) {
    const denied=spawnSync(process.execPath,[cli,'export','--run',runId,'--output',output],{cwd:root,encoding:'utf8'});
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/qualified campaign promotion/u);
    const rawCli=path.join(root,'benchmarks/sentinel-todo/runtime/benchmark.mjs');
    for(const args of [
      ['journal-init','--output',output,'--case','A','--sentinel-sha','0'.repeat(40),'--run-mode','full','--production-profile','production-v3'],
      ['finalize','--output',output,'--workspace',temp,'--case','A','--spec',first,'--journal',first],
      ['compare','--output',output,'--before',first,'--after',first],
    ]) {
      const raw=spawnSync(process.execPath,[rawCli,...args],{cwd:root,encoding:'utf8'});
      assert.notEqual(raw.status,0);assert.match(raw.stderr,/qualified campaign promotion/u);
    }
  }
  assert.deepEqual(await fs.readdir(official),historyBefore);
  for (const [name, mutate] of [
    ['missing', value => { delete value.productAcceptance; }],
    ['null', value => { value.productAcceptance = null; }],
    ['wrong-case', value => { value.productAcceptance.caseId = 'C'; }],
    ['wrong-instrument', value => { value.productAcceptance.instrumentSha256 = `sha256:${'0'.repeat(64)}`; }],
    ['foreign-product', value => { value.productAcceptance.product.root = path.join(temp, 'another-candidate'); }],
    ['different-product-bytes', value => { value.productAcceptance.product.sha256 = `sha256:${'f'.repeat(64)}`; }],
    ['false-pass', value => { value.productAcceptance.passed = false; }],
  ]) {
    const invalid = JSON.parse(initialRaw); mutate(invalid);
    await fs.writeFile(rawPath, JSON.stringify(invalid));
    const output = path.join(temp, `unqualified-${name}.json`);
    const denied = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', output], { cwd: root, encoding: 'utf8' });
    assert.notEqual(denied.status, 0, name); assert.match(denied.stderr, /productAcceptance/u);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    const forged = structuredClone(report); mutate(forged.cases[0]);
    const destination = path.join(temp, `unqualified-publication-${name}`);
    await assert.rejects(publishMeasurement(forged, { root: destination }), /productAcceptance/u);
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  }
  await fs.writeFile(rawPath, initialRaw);
  for (const variant of ['failed-cases', 'not-run-cases', 'missing-case', 'duplicate-case']) {
    const invalid = structuredClone(report);
    if (variant === 'failed-cases' || variant === 'not-run-cases') for (const row of invalid.cases) {
      row.status = variant === 'failed-cases' ? 'FAIL' : 'NOT_RUN'; delete row.productAcceptance;
    }
    if (variant === 'missing-case') invalid.cases.pop();
    if (variant === 'duplicate-case') invalid.cases[2] = structuredClone(invalid.cases[0]);
    const destination = path.join(temp, `invalid-headline-${variant}`);
    await assert.rejects(publishMeasurement(invalid, { root: destination }), /complete passing case scope/u);
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  }
  assert.equal(report.aggregate.operations, 1);
  assert.equal(report.cases[0].telemetry.main.input, 100);
  assert.equal(report.cases[0].telemetry.runner, UNAVAILABLE);
  // Capacity retries are transport attempts, not duplicated workflow events;
  // their usage must still contribute to complete turn coverage.
  const retryFiles = ['case-a/01-spec_init.json', 'case-a/case-state.json', 'summary.json'];
  const retryOriginals = await Promise.all(retryFiles.map(file => fs.readFile(path.join(runRoot, file))));
  const retryEvidence = JSON.parse(retryOriginals[0]);
  retryEvidence.capacityRetry = { attempts: [
    { usageObservation: { ...retryEvidence.turn.usageObservation, eventId: 'capacity-main', delta: { input: 20, output: 2, cachedInput: 0, reasoningOutput: 0 } } },
    { usageObservation: retryEvidence.turn.usageObservation },
  ] };
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(retryEvidence));
  await fs.writeFile(path.join(runRoot, retryFiles[1]), JSON.stringify({ ...JSON.parse(retryOriginals[1]), mainTurns: 2 }));
  const retrySummary = JSON.parse(retryOriginals[2]); retrySummary.cases.A.mainTurns = 2;
  await fs.writeFile(path.join(runRoot, retryFiles[2]), JSON.stringify(retrySummary));
  const retryReport = await exportMeasurement(runId);
  assert.equal(retryReport.cases[0].telemetry.coverage.main, '2/2');
  assert.equal(retryReport.cases[0].telemetry.main.input, 120);
  assert.equal(retryReport.aggregate.operations, 1);
  retryEvidence.capacityRetry.attempts[0].usageObservation = { status: 'unavailable', source: 'main', eventId: 'capacity-main' };
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(retryEvidence));
  const unknownCapacity = await exportMeasurement(runId);
  assert.equal(unknownCapacity.cases[0].telemetry.coverage.main, '1/2');
  assert.equal(unknownCapacity.cases[0].telemetry.main.input, UNAVAILABLE);
  assert.equal(unknownCapacity.measurement.status, 'incomplete');
  assert.ok(unknownCapacity.measurement.missing.includes('case A main coverage'));
  await assert.rejects(publishMeasurement(unknownCapacity, { root: path.join(temp, 'unknown-capacity') }), /measurement incomplete/u);
  await Promise.all(retryFiles.map((file, index) => fs.writeFile(path.join(runRoot, file), retryOriginals[index])));
  const childEvidence = JSON.parse(retryOriginals[0]);
  const childState = { ...JSON.parse(retryOriginals[1]), runnerTurns: 1 };
  const childSummary = JSON.parse(retryOriginals[2]); childSummary.cases.A.runnerTurns = 1;
  await fs.writeFile(path.join(runRoot, retryFiles[1]), JSON.stringify(childState));
  await fs.writeFile(path.join(runRoot, retryFiles[2]), JSON.stringify(childSummary));
  const missingChild = await exportMeasurement(runId);
  assert.equal(missingChild.cases[0].telemetry.coverage.runner, '0/1');
  assert.equal(missingChild.measurement.status, 'incomplete');
  const childUsage = { status: 'attributable', source: 'runner', eventId: 'synthetic-child-turn',
    threadId: 'synthetic-child', segment: 'first-turn',
    delta: { input: 25, cachedInput: 5, output: 4, reasoningOutput: 1 } };
  childEvidence.runner = { usageObservations: [childUsage, structuredClone(childUsage)] };
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
  const duplicateChild = await exportMeasurement(runId);
  assert.equal(duplicateChild.measurement.status, 'complete');
  assert.equal(duplicateChild.cases[0].telemetry.runner.input, 25, 'replay must not double count a child');
  childEvidence.runner.usageObservations.push({ ...structuredClone(childUsage), status: 'duplicate',
    delta: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, cacheWrite: 0, total: 0 } });
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
  const zeroDuplicate = await exportMeasurement(runId);
  assert.equal(zeroDuplicate.measurement.status, 'complete');
  assert.equal(zeroDuplicate.cases[0].telemetry.runner.input, 25);
  childEvidence.runner.usageObservations[1].delta.input = 26;
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
  const conflictingChild = await exportMeasurement(runId);
  assert.equal(conflictingChild.measurement.status, 'incomplete', 'same observation identity cannot carry conflicting usage');
  assert.equal(conflictingChild.aggregate.telemetry.main.meanInputPerTurn, UNAVAILABLE,
    'unknown complete input cannot be divided into a NaN mean');
  assert.deepEqual(JSON.parse(JSON.stringify(conflictingChild)), conflictingChild,
    'partial diagnostic metrics must survive JSON persistence without NaN/null substitution');
  await assert.rejects(publishMeasurement(conflictingChild, { root: path.join(temp, 'conflicting-child') }), /measurement incomplete/u);
  for (const [label, values] of [
    ['late conflict', [...childEvidence.runner.usageObservations].reverse()],
    ['cache conflict', [childUsage, { ...structuredClone(childUsage), delta: { ...childUsage.delta, cachedInput: 6 } }]],
    ['nonzero duplicate label', [childUsage, { ...structuredClone(childUsage), status: 'duplicate' }]],
    ['unknown source', [{ ...childUsage, source: 'unknown' }]],
    ['unknown identity', [{ ...childUsage, eventId: null, threadId: null, segment: null }]],
    ['cache absent', [{ ...childUsage, delta: { input: 25, output: 4 } }]],
    ['malformed observation list', { privateTextMustNotBeExported: 'untrusted-usage-secret' }],
  ]) {
    childEvidence.runner.usageObservations = values;
    await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
    const incomplete = await exportMeasurement(runId);
    assert.equal(incomplete.measurement.status, 'incomplete', label);
    assert.throws(() => validateMeasurementReport(incomplete, { qualify: true }), /measurement incomplete/u, label);
    assert.equal(JSON.stringify(incomplete).includes('untrusted-usage-secret'), false, 'malformed usage payload is not exported');
  }
  childEvidence.runner.usageObservations = [childUsage,
    { ...structuredClone(childUsage), eventId: 'another-child-turn', threadId: 'another-child' }];
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
  await fs.writeFile(path.join(runRoot, retryFiles[1]), JSON.stringify({ ...childState, runnerTurns: 2 }));
  childSummary.cases.A.runnerTurns = 2;
  await fs.writeFile(path.join(runRoot, retryFiles[2]), JSON.stringify(childSummary));
  const independentChildren = await exportMeasurement(runId);
  assert.equal(independentChildren.measurement.status, 'complete');
  assert.equal(independentChildren.cases[0].telemetry.runner.input, 50, 'equal counters on distinct calls are not a replay');
  childEvidence.capacityRetry = { attempts: { privateTextMustNotBeExported: 'untrusted-usage-secret' } };
  await fs.writeFile(path.join(runRoot, retryFiles[0]), JSON.stringify(childEvidence));
  const malformedRetry = await exportMeasurement(runId);
  assert.equal(malformedRetry.measurement.status, 'incomplete');
  assert.equal(JSON.stringify(malformedRetry).includes('untrusted-usage-secret'), false);
  await Promise.all(retryFiles.map((file, index) => fs.writeFile(path.join(runRoot, file), retryOriginals[index])));
  assert.equal(report.provenance.baseSha, 'fixture-base');
  assert.equal(report.cases[0].provider, UNAVAILABLE);
  assert.equal(report.cases[0].operationDurations[0].durationMs, 0);
  assert.equal(compareMeasurements(report, report).deltas.g3.mainInputTokens, 0);
  const unavailable = structuredClone(report); unavailable.aggregate.telemetry.runner = UNAVAILABLE;
  validateMeasurementReport(unavailable);
  assert.equal(compareMeasurements(unavailable, unavailable).deltas.g3.runnerInputTokens, UNAVAILABLE);
  const partial = structuredClone(report); partial.aggregate.telemetry.main.input = UNAVAILABLE;
  delete partial.measurement;
  assert.equal(compareMeasurements(partial, partial).deltas, UNAVAILABLE);
  const partialCoverage = structuredClone(report); partialCoverage.aggregate.telemetry.coverage.main = '0/1';
  delete partialCoverage.measurement;
  assert.equal(compareMeasurements(report, partialCoverage).deltas, UNAVAILABLE);
  const profileOnly = structuredClone(report); profileOnly.comparability.profile = 'other-profile'; profileOnly.run.profile = 'other-profile';
  assert.equal(compareMeasurements(report, profileOnly, true).profileExperiment, true);
  const incompatible = structuredClone(profileOnly); incompatible.comparability.metricDefinitions = 'changed';
  assert.equal(compareMeasurements(report, incompatible, true).deltas, UNAVAILABLE);
  assert.throws(() => validateMeasurementReport({ schemaVersion: 1 }), /invalid measurement report/);
  const publicRoot = path.join(temp, 'measurements');
  await publishMeasurement(report, { root: publicRoot });
  const historyBytes = await fs.readFile(path.join(publicRoot, `${runId}.json`));
  assert.deepEqual(await fs.readFile(path.join(publicRoot, 'latest.json')), historyBytes, 'latest JSON must be a faithful history copy');
  const markdown = await fs.readFile(path.join(publicRoot, 'latest.md'), 'utf8');
  assert.match(markdown, new RegExp(`\\[${runId}\\.json\\]\\(${runId}\\.json\\)`));
  assert.match(markdown, /Comparison/);
  await publishMeasurement(report, { root: publicRoot });
  assert.deepEqual(await fs.readFile(path.join(publicRoot, `${runId}.json`)), historyBytes, 'same run publication must be idempotent');
  const collision = structuredClone(report); collision.run.status = 'BLOCKED';
  await assert.rejects(publishMeasurement(collision, { root: publicRoot }), /collision/);
  assert.deepEqual(await fs.readFile(path.join(publicRoot, `${runId}.json`)), historyBytes, 'collision must preserve original evidence');
  const identityBeforeMeasurements = await currentFunctionalIdentity();
  const repoMeasurements = path.join(root, 'benchmarks/sentinel-todo/measurements');
  await fs.mkdir(repoMeasurements, { recursive: true });
  await fs.writeFile(path.join(repoMeasurements, 'measurement-only-fixture.json'), '{"fixture":true}\n');
  const identityAfterMeasurements = await currentFunctionalIdentity();
  assert.deepEqual(identityAfterMeasurements, identityBeforeMeasurements, 'measurement-only output must not change functional identity');
  await fs.rm(path.join(repoMeasurements, 'measurement-only-fixture.json'));
  await fs.rmdir(repoMeasurements).catch(() => {});
  const sourceFixture = path.join(root, 'scripts', `test-functional-source-${process.pid}.tmp`);
  try {
    await fs.writeFile(sourceFixture, 'source change fixture\n');
    assert.notDeepEqual(await currentFunctionalIdentity(), identityBeforeMeasurements, 'functional code changes must change source identity');
  } finally { await fs.rm(sourceFixture, { force: true }); }
  const runFile = path.join(runRoot, 'run.json'); const originalRun = await fs.readFile(runFile, 'utf8');
  for (const id of ['b', 'c']) await fs.rename(path.join(runRoot, `case-${id}`), path.join(temp, `parked-case-${id}`));
  const partialRun = JSON.parse(originalRun); partialRun.status = 'BLOCKED'; partialRun.cases = ['A', 'B', 'C'];
  await fs.writeFile(runFile, JSON.stringify(partialRun));
  const summaryFile = path.join(runRoot, 'summary.json'); const originalSummary = await fs.readFile(summaryFile, 'utf8');
  const partialSummary = JSON.parse(originalSummary); partialSummary.status = 'BLOCKED';
  partialSummary.cases.A.status = 'BLOCKED'; partialSummary.cases.A.mainTurns = 2; partialSummary.cases.B = { status: 'NOT_RUN' }; partialSummary.cases.C = { status: 'NOT_RUN' };
  await fs.writeFile(summaryFile, JSON.stringify(partialSummary));
  const stateFile = path.join(runRoot, 'case-a/case-state.json'); const originalState = await fs.readFile(stateFile, 'utf8');
  const blockedState = JSON.parse(originalState); blockedState.status = 'BLOCKED'; blockedState.mainTurns = 2; blockedState.finalizer.exitCode = 1;
  blockedState.terminal = { result: 'OFFICIAL_RUNNER_RESULT_BLOCKED', blocker: 'OFFICIAL_RUNNER_RESULT_BLOCKED' };
  await fs.writeFile(stateFile, JSON.stringify(blockedState));
  const blockedRaw = JSON.parse(await fs.readFile(rawPath, 'utf8'));
  blockedRaw.status = 'FAIL'; blockedRaw.finalExecutionState = 'RUNNER_RESULT_BLOCKED'; blockedRaw.finalTests = { command: 'node --test', exitCode: 0, passed: true };
  blockedRaw.specClosed = false;
  await fs.writeFile(rawPath, JSON.stringify(blockedRaw));
  const blocked = await exportMeasurement(runId);
  assert.equal(blocked.run.status, 'BLOCKED');
  assert.deepEqual(blocked.cases.map((c) => [c.id, c.status, c.operations, c.mainTurns]), [['A', 'BLOCKED', 1, 2], ['B', 'NOT_RUN', 0, 0], ['C', 'NOT_RUN', 0, 0]]);
  assert.equal(blocked.cases[0].terminalResult, 'OFFICIAL_RUNNER_RESULT_BLOCKED');
  assert.equal(blocked.cases[0].execution, 'RUNNER_RESULT_BLOCKED');
  assert.equal(blocked.cases[0].finalizerExitCode, 1);
  assert.equal(blocked.cases[0].finalTestsPassed, true);
  assert.equal(blocked.cases[0].telemetry.coverage.main, '1/2');
  assert.equal(blocked.cases[0].telemetry.main.input, UNAVAILABLE);
  assert.equal(blocked.cases[0].telemetry.main.observedInput, 100);
  assert.equal(blocked.aggregate.telemetry.main.input, UNAVAILABLE);
  assert.equal(blocked.aggregate.telemetry.main.observedInput, 100);
  assert.equal(compareMeasurements(report, blocked).deltas, UNAVAILABLE, 'partial runs must not produce savings deltas');
  const missingUsageCase = path.join(runRoot, 'case-b');
  await fs.mkdir(missingUsageCase);
  await fs.writeFile(path.join(missingUsageCase, 'case-state.json'), JSON.stringify({ status: 'BLOCKED',
    startedAt: blockedState.startedAt, endedAt: blockedState.endedAt, mainTurns: 1, runnerTurns: 0, operations: [] }));
  await fs.writeFile(path.join(missingUsageCase, 'journal.json'), JSON.stringify({ events: [] }));
  await fs.writeFile(stateFile, JSON.stringify({ ...blockedState, mainTurns: 1 }));
  await fs.writeFile(summaryFile, JSON.stringify({ ...partialSummary, cases: { ...partialSummary.cases,
    A: { ...partialSummary.cases.A, mainTurns: 1 }, B: { status: 'BLOCKED', operations: 0, mainTurns: 1, runnerTurns: 0 } } }));
  const missingUsage = await exportMeasurement(runId);
  assert.equal(missingUsage.aggregate.telemetry.coverage.main, '1/2');
  assert.equal(missingUsage.aggregate.telemetry.main.input, UNAVAILABLE, 'a case with no usage must not disappear from aggregate coverage');
  assert.equal(missingUsage.aggregate.telemetry.main.observedInput, 100);
  assert.equal(missingUsage.cases[1].finalizer, UNAVAILABLE);
  await fs.rm(missingUsageCase, { recursive: true });
  for (const status of ['CANCELLED', 'PAUSED_BUDGET_OR_QUOTA']) {
    const cancelledRun = { ...partialRun, status };
    const cancelledSummary = { ...partialSummary, status, cases: { ...partialSummary.cases, A: { ...partialSummary.cases.A, status } } };
    const cancelledState = { ...blockedState, status, terminal: { result: status, blocker: status } };
    await fs.writeFile(runFile, JSON.stringify(cancelledRun));
    await fs.writeFile(summaryFile, JSON.stringify(cancelledSummary));
    await fs.writeFile(stateFile, JSON.stringify(cancelledState));
    const cancelled = await exportMeasurement(runId);
    assert.equal(cancelled.run.status, status);
    assert.equal(cancelled.cases[0].status, status);
    assert.equal(cancelled.cases[0].blocker, status);
  }
  await fs.writeFile(summaryFile, originalSummary);
  const interruptedSummary = path.join(temp, 'interrupted-summary.json');
  await fs.rename(summaryFile, interruptedSummary);
  await assert.rejects(exportMeasurement(runId), /run summary identity/);
  await fs.rename(interruptedSummary, summaryFile);
  await fs.writeFile(runFile, originalRun);
  await fs.writeFile(stateFile, originalState);
  for (const [mode, status] of [['case', 'PASS'], ['focal', 'FOCAL_STOP']]) {
    await fs.writeFile(runFile, JSON.stringify({ ...JSON.parse(originalRun), mode, status }));
    await fs.writeFile(summaryFile, JSON.stringify({ ...JSON.parse(originalSummary), mode, status,
      cases: { A: { ...JSON.parse(originalSummary).cases.A, status } } }));
    await fs.writeFile(stateFile, JSON.stringify({ ...JSON.parse(originalState), status }));
    await assert.rejects(exportMeasurement(runId), /supported mode and matching identity/);
    const scoped = structuredClone(report); scoped.run.mode = mode; scoped.run.status = status; scoped.cases = [scoped.cases[0]];
    assert.equal(compareMeasurements(scoped, scoped).directlyComparable, false, 'partial scope cannot certify a full-run comparison');
    const destination = path.join(temp, `scoped-${mode}`);
    await assert.rejects(publishMeasurement(scoped, { root: destination, updateLatest: false }), /only be published for full runs/);
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
    const deniedOutput = path.join(temp, `denied-${mode}.json`);
    const denied = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', deniedOutput], { cwd: root, encoding: 'utf8' });
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /supported mode and matching identity/);
    await assert.rejects(fs.lstat(deniedOutput), { code: 'ENOENT' });
  }
  await fs.writeFile(runFile, originalRun);
  await fs.writeFile(summaryFile, originalSummary);
  await fs.writeFile(stateFile, originalState);
  const journalFile = path.join(runRoot, 'case-a/journal.json');
  for (const id of ['b', 'c']) await fs.rename(path.join(temp, `parked-case-${id}`), path.join(runRoot, `case-${id}`));
  const originalJournal = await fs.readFile(journalFile);
  const originalRaw = await fs.readFile(rawPath);
  // Full-mode fixture exercises retained/current finalizer pointer validation;
  // case/focal publication is rejected above, independently of finalizer history.
  const resumedRawPath = path.join(runRoot, 'case-a/raw-resume-10.json');
  const resumedState = { ...JSON.parse(originalState), mainTurns: 10, privateHomeRemoved: true,
    finalizerHistory: [{ exitCode: 1, rawPath }], finalizer: { exitCode: 0, rawPath: resumedRawPath },
    operations: Array.from({ length: 10 }, () => ({ evidencePath: '01-spec_init.json' })) };
  const resumedJournal = { ...JSON.parse(originalJournal), caseId: 'A', runMode: 'focal',
    events: Array.from({ length: 10 }, () => ({ operation: 'SPEC_INIT', slice: null, childDispatches: [] })) };
  const resumedRaw = { ...JSON.parse(originalRaw), caseId: 'A', runMode: 'focal', status: 'PASS',
    finalExecutionState: 'COMPLETE', specClosed: true, operations: { total: 10, findingsCycles: 0 } };
  await fs.writeFile(rawPath, JSON.stringify({ ...resumedRaw, status: 'FAIL', finalExecutionState: 'INIT',
    specClosed: false, operations: { total: 4, findingsCycles: 0 } }));
  const focalRawBytes = await fs.readFile(rawPath);
  await fs.writeFile(resumedRawPath, JSON.stringify(resumedRaw));
  const resumedRawBytes = await fs.readFile(resumedRawPath);
  await fs.writeFile(stateFile, JSON.stringify(resumedState));
  await fs.writeFile(journalFile, JSON.stringify(resumedJournal));
  await fs.writeFile(runFile, originalRun);
  await fs.writeFile(summaryFile, JSON.stringify({ ...JSON.parse(originalSummary),
    cases: { ...JSON.parse(originalSummary).cases,
      A: { caseId: 'A', status: 'PASS', operations: 10, mainTurns: 10, runnerTurns: 0, rawPath: resumedRawPath } } }));
  const resumed = await exportMeasurement(runId);
  assert.equal(resumed.cases[0].operations, 10);
  assert.equal(resumed.cases[0].execution, 'COMPLETE'); assert.equal(resumed.cases[0].specClosed, true);
  assert.equal(resumed.cases[0].finalizer, 'PASS');
  assert.equal(resumed.measurement.status, 'incomplete', 'replaying one proof does not measure ten calls');
  await assert.rejects(publishMeasurement(resumed, { root: path.join(temp, 'resumed-incomplete'), updateLatest: false }),
    /measurement incomplete/u);
  // Keep the positive pointer/publication check, with ten explicitly distinct
  // synthetic observations rather than multiplying a replayed event.
  const completeState = structuredClone(resumedState);
  for (let index = 0; index < 10; index++) {
    const evidencePath = `synthetic-resume-${index}.json`;
    completeState.operations[index].evidencePath = evidencePath;
    await fs.writeFile(path.join(runRoot, 'case-a', evidencePath), JSON.stringify({
      turn: { usageObservation: { status: 'attributable', source: 'main', eventId: `resume-main-${index}`,
        delta: { input: 100, output: 20, cachedInput: 10, reasoningOutput: 5 } } },
    }));
  }
  await fs.writeFile(stateFile, JSON.stringify(completeState));
  await fs.writeFile(journalFile, JSON.stringify({ ...resumedJournal,
    events: resumedJournal.events.map(event => ({ ...event, durationMs: 0 })) }));
  const resumedComplete = await exportMeasurement(runId);
  assert.equal(resumedComplete.measurement.status, 'complete');
  const resumedSaved = await publishMeasurement(resumedComplete, { root: path.join(temp, 'resumed'), updateLatest: false });
  assert.equal(JSON.parse(await fs.readFile(resumedSaved.historyPath, 'utf8')).cases[0].operations, 10);
  assert.deepEqual(await fs.readFile(rawPath), focalRawBytes, 'first focal raw remains historical evidence');
  assert.deepEqual(await fs.readFile(resumedRawPath), resumedRawBytes, 'current raw remains immutable');
  const outsideRawPath = path.join(temp, 'raw-resume-10.json');
  await fs.writeFile(outsideRawPath, resumedRawBytes);
  for (const variant of ['outside', 'traversal', 'wrong-name', 'missing', 'missing-pointer', 'symlink',
    'wrong-case', 'wrong-journal-case', 'wrong-mode', 'wrong-count']) {
    const invalid = structuredClone(resumedState);
    if (variant === 'outside') invalid.finalizer.rawPath = outsideRawPath;
    if (variant === 'traversal') invalid.finalizer.rawPath = `${runRoot}/case-a/../case-a/raw-resume-10.json`;
    if (variant === 'wrong-name') invalid.finalizer.rawPath = path.join(runRoot, 'case-a/raw-resume-4.json');
    if (variant === 'missing-pointer') delete invalid.finalizer.rawPath;
    if (variant === 'missing') await fs.rm(resumedRawPath);
    if (variant === 'symlink') { await fs.rm(resumedRawPath); await fs.symlink(outsideRawPath, resumedRawPath); }
    if (variant === 'wrong-case') await fs.writeFile(resumedRawPath, JSON.stringify({ ...resumedRaw, caseId: 'B' }));
    if (variant === 'wrong-journal-case') await fs.writeFile(journalFile, JSON.stringify({ ...resumedJournal, caseId: 'B' }));
    if (variant === 'wrong-mode') await fs.writeFile(resumedRawPath, JSON.stringify({ ...resumedRaw, runMode: 'full' }));
    if (variant === 'wrong-count') await fs.writeFile(resumedRawPath, JSON.stringify({ ...resumedRaw, operations: { total: 9 } }));
    await fs.writeFile(stateFile, JSON.stringify(invalid));
    await assert.rejects(exportMeasurement(runId), /finalizer|summary differs/, variant);
    if (variant === 'outside') {
      const campaignRoot = path.join(temp, 'functional-export-denial');
      // This start gate exercises incomplete historical case/home evidence;
      // the actual outside-pointer export rejection is asserted above. Starting
      // a new campaign no longer exports or deletes historical runs.
      const configuration = path.join(campaignRoot, 'benchmarks/sentinel-todo/benchmark.json');
      await fs.mkdir(path.dirname(configuration), { recursive: true });
      await fs.copyFile(path.join(benchmarkDir, 'benchmark.json'), configuration);
      const scratchRun = path.join(campaignRoot, 'benchmark-temp', runId);
      await fs.mkdir(path.join(scratchRun, 'case-a'), { recursive: true });
      for (const name of ['.sentinel-benchmark-owned', 'run.json', 'summary.json', 'case-a/case-state.json'])
        await fs.copyFile(path.join(runRoot, name), path.join(scratchRun, name));
      const before = await fs.readFile(path.join(scratchRun, 'case-a/case-state.json'));
      let cleaned = false; let dispatched = false;
      await assert.rejects(runFunctionalBenchmark({ root: campaignRoot, hooks: {
        verify: async () => ({ code: 0 }), processes: () => [], exportMeasurement,
        cleanRun: async () => { cleaned = true; throw new Error('unexpected cleanup'); },
        runFull: async () => { dispatched = true; throw new Error('unexpected dispatch'); },
      } }), { code: 'BLOCKED_CLEANUP' });
      assert.equal(cleaned, false); assert.equal(dispatched, false);
      assert.deepEqual(await fs.readFile(path.join(scratchRun, 'case-a/case-state.json')), before);
      assert.equal(await fs.stat(path.join(campaignRoot, 'benchmark-temp/.campaign-active.json')).then(() => true, () => false), false);
    }
    await fs.rm(resumedRawPath, { force: true }); await fs.writeFile(resumedRawPath, resumedRawBytes);
    await fs.writeFile(journalFile, JSON.stringify(resumedJournal));
  }
  assert.deepEqual(await fs.readFile(rawPath), focalRawBytes);
  await fs.rm(resumedRawPath); await fs.writeFile(rawPath, originalRaw);
  await fs.writeFile(stateFile, originalState); await fs.writeFile(journalFile, originalJournal);
  await fs.writeFile(runFile, JSON.stringify({ ...JSON.parse(originalRun), status: 'BLOCKED', cases: ['A'] }));
  await fs.writeFile(summaryFile, JSON.stringify({ ...JSON.parse(originalSummary), status: 'BLOCKED',
    cases: { A: { status: 'BLOCKED', operations: 0, mainTurns: 0, runnerTurns: 0 } } }));
  await fs.writeFile(stateFile, JSON.stringify({ ...JSON.parse(originalState), status: 'BLOCKED',
    terminal: { result: 'BLOCKED', blocker: 'DRIVER_FAILURE' }, operations: [], mainTurns: 0, runnerTurns: 0,
    finalizer: null, privateHomeNotCreated: true }));
  await fs.writeFile(journalFile, JSON.stringify({ status: 'ACTIVE', events: [] }));
  await fs.rm(rawPath);
  const zeroTurn = await exportMeasurement(runId);
  assert.equal(zeroTurn.cases[0].operations, 0); assert.equal(zeroTurn.cases[0].mainTurns, 0);
  assert.equal(zeroTurn.cases[0].finalizer, UNAVAILABLE);
  assert.equal(zeroTurn.cases[0].blocker, 'DRIVER_FAILURE');
  const zeroSaved = await publishMeasurement(zeroTurn, { root: path.join(temp, 'zero-turn'), updateLatest: false });
  assert.equal(JSON.parse(await fs.readFile(zeroSaved.historyPath, 'utf8')).run.status, 'BLOCKED');
  await fs.writeFile(runFile, originalRun); await fs.writeFile(summaryFile, originalSummary);
  await fs.writeFile(stateFile, originalState); await fs.writeFile(journalFile, originalJournal);
  await fs.writeFile(rawPath, originalRaw);
  await fs.writeFile(rawPath, initialRaw);
  const noOverwrite = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', first], { cwd: root, encoding: 'utf8' });
  assert.notEqual(noOverwrite.status, 0);
  assert.match(noOverwrite.stderr, /exist|overwrite/u, 'existing output guard is reached with qualified raw evidence');
  const mismatched = JSON.parse(originalRun); mismatched.snapshot.snapshotSha256 = 'sha256:wrong';
  await fs.writeFile(runFile, JSON.stringify(mismatched));
  const badIdentity = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', path.join(temp, 'bad.json')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badIdentity.status, 0);
  await fs.writeFile(runFile, originalRun);
  const snapshotConfig = path.join(snapshotRoot, 'benchmarks/sentinel-todo/benchmark.json');
  const originalConfig = await fs.readFile(snapshotConfig);
  await fs.appendFile(snapshotConfig, ' ');
  const badSnapshot = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', path.join(temp, 'bad-snapshot.json')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(badSnapshot.status, 0);
  await fs.writeFile(snapshotConfig, originalConfig);
  const incomplete = JSON.parse(originalRun); incomplete.status = 'ACTIVE';
  await fs.writeFile(runFile, JSON.stringify(incomplete));
  const active = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', path.join(temp, 'active.json')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(active.status, 0);
  await fs.writeFile(runFile, originalRun);
  assert.equal(createHash('sha256').update(await fs.readFile(rawPath)).digest('hex'), rawHash, 'export must not mutate raw evidence');
  console.log('benchmark measurement tests passed');
} finally {
  await fs.rm(runRoot, { recursive: true, force: true });
  await fs.rm(temp, { recursive: true, force: true });
  if (!hadBenchmarkTemp) await fs.rmdir(benchmarkTempRoot).catch(() => {});
}
