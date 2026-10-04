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
  const sources = [];
  for (const prefix of ['skills', 'agents', 'templates', 'scripts', 'benchmarks/sentinel-todo']) sources.push(...(await filesUnder(snapshotRoot, prefix)));
  const allFiles = await filesUnder(snapshotRoot);
  const config = JSON.parse(await fs.readFile(path.join(snapshotRoot, 'benchmarks/sentinel-todo/benchmark.json'), 'utf8'));
  const meta = { protocol: 'sentinel-sdk-context-v1', baseSha: 'fixture-base', dirty: false, functionalDiffSha256: 'sha256:fixture-diff',
    sourceFunctionalSha256: await digestFiles(snapshotRoot, sources), sourceFileCount: sources.length,
    snapshotSha256: await digestFiles(snapshotRoot, allFiles), snapshotFileCount: allFiles.length, createdAt: '2026-01-01T00:00:00.000Z' };
  await fs.writeFile(path.join(runRoot, 'snapshot.json'), `${JSON.stringify(meta)}\n`);
  const now = '2026-01-01T00:00:00.000Z';
  const evidence = { operation: 'SPEC_INIT', turn: { usageObservation: { status: 'attributable', source: 'main', eventId: 'fixture-main', delta:
    { input: 100, output: 20, cachedInput: 10, reasoningOutput: 5 } } } };
  await fs.writeFile(path.join(runRoot, 'case-a/01-spec_init.json'), JSON.stringify(evidence));
  const raw = { status: 'PASS', finalExecutionState: 'COMPLETE', specClosed: true, finalTestsPassed: true,
    decomposition: { slices: 0 }, operations: { findingsCycles: 0 } };
  await fs.writeFile(path.join(runRoot, 'case-a/raw.json'), JSON.stringify(raw));
  await fs.writeFile(path.join(runRoot, 'case-a/case-state.json'), JSON.stringify({ caseId: 'A', status: 'PASS', startedAt: now, endedAt: now,
    mainTurns: 1, runnerTurns: 0, finalizer: { exitCode: 0 }, operations: [{ evidencePath: '01-spec_init.json' }] }));
  await fs.writeFile(path.join(runRoot, 'case-a/journal.json'), JSON.stringify({ events: [{ operation: 'SPEC_INIT', slice: null, childDispatches: [] }] }));
  const run = { runId, status: 'PASS', mode: 'full', cases: ['A'], profile: 'production-v2', startedAt: now, endedAt: now,
    snapshot: { sourceFunctionalSha256: meta.sourceFunctionalSha256, snapshotSha256: meta.snapshotSha256 } };
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runId, status: 'PASS', mode: 'full', cases: { A:
    { caseId: 'A', status: 'PASS', operations: 1, mainTurns: 1, runnerTurns: 0 } } }));
}

try {
  const baseline = JSON.parse(await fs.readFile(path.join(benchmarkDir, 'baselines/baseline-v1.json'), 'utf8'));
  validateMeasurementReport(baseline);
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
  const rawHash = createHash('sha256').update(await fs.readFile(rawPath)).digest('hex');
  const first = path.join(temp, 'first.json'); const second = path.join(temp, 'second.json');
  execFileSync(process.execPath, [cli, 'export', '--run', runId, '--output', first], { cwd: root });
  execFileSync(process.execPath, [cli, 'export', '--run', runId, '--output', second], { cwd: root });
  assert.equal(await fs.readFile(first, 'utf8'), await fs.readFile(second, 'utf8'), 'report bytes must be deterministic');
  const report = JSON.parse(await fs.readFile(first, 'utf8'));
  validateMeasurementReport(report);
  assert.equal(report.aggregate.operations, 1);
  assert.equal(report.cases[0].telemetry.main.input, 100);
  assert.equal(report.cases[0].telemetry.runner, UNAVAILABLE);
  assert.equal(report.provenance.baseSha, 'fixture-base');
  assert.equal(report.cases[0].provider, UNAVAILABLE);
  assert.equal(report.cases[0].operationDurations[0].durationMs, UNAVAILABLE);
  assert.equal(compareMeasurements(report, report).deltas.g3.mainInputTokens, 0);
  const unavailable = structuredClone(report); unavailable.aggregate.telemetry.runner = UNAVAILABLE;
  validateMeasurementReport(unavailable);
  assert.equal(compareMeasurements(unavailable, unavailable).deltas.g3.runnerInputTokens, UNAVAILABLE);
  const partial = structuredClone(report); partial.aggregate.telemetry.main.input = UNAVAILABLE;
  assert.equal(compareMeasurements(partial, partial).deltas.g3.mainInputTokens, UNAVAILABLE);
  const partialCoverage = structuredClone(report); partialCoverage.aggregate.telemetry.coverage.main = '0/1';
  assert.equal(compareMeasurements(report, partialCoverage).deltas.g3.mainInputTokens, UNAVAILABLE);
  const profileOnly = structuredClone(report); profileOnly.comparability.profile = 'other-profile';
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
    const scoped = await exportMeasurement(runId);
    assert.equal(scoped.run.mode, mode); assert.equal(scoped.run.status, status);
    assert.equal(scoped.cases.length, 1);
    assert.equal(compareMeasurements(scoped, scoped).directlyComparable, false, 'partial scope cannot certify a full-run comparison');
    const saved = await publishMeasurement(scoped, { root: path.join(temp, `scoped-${mode}`), updateLatest: false });
    assert.equal(JSON.parse(await fs.readFile(saved.historyPath, 'utf8')).run.mode, mode);
  }
  await fs.writeFile(runFile, originalRun);
  await fs.writeFile(summaryFile, originalSummary);
  await fs.writeFile(stateFile, originalState);
  const journalFile = path.join(runRoot, 'case-a/journal.json');
  const originalJournal = await fs.readFile(journalFile);
  const originalRaw = await fs.readFile(rawPath);
  // The manager keeps the first focal finalizer and records the resumed one separately.
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
  await fs.writeFile(runFile, JSON.stringify({ ...JSON.parse(originalRun), mode: 'case' }));
  await fs.writeFile(summaryFile, JSON.stringify({ ...JSON.parse(originalSummary), mode: 'case',
    cases: { A: { caseId: 'A', status: 'PASS', operations: 10, mainTurns: 10, runnerTurns: 0, rawPath: resumedRawPath } } }));
  const resumed = await exportMeasurement(runId);
  assert.equal(resumed.cases[0].operations, 10);
  assert.equal(resumed.cases[0].execution, 'COMPLETE'); assert.equal(resumed.cases[0].specClosed, true);
  assert.equal(resumed.cases[0].finalizer, 'PASS');
  const resumedSaved = await publishMeasurement(resumed, { root: path.join(temp, 'resumed'), updateLatest: false });
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
  await fs.writeFile(runFile, JSON.stringify({ ...JSON.parse(originalRun), mode: 'case', status: 'BLOCKED' }));
  await fs.writeFile(summaryFile, JSON.stringify({ ...JSON.parse(originalSummary), mode: 'case', status: 'BLOCKED',
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
  await fs.writeFile(rawPath, JSON.stringify({ status: 'PASS', finalExecutionState: 'COMPLETE', specClosed: true, finalTestsPassed: true,
    decomposition: { slices: 0 }, operations: { findingsCycles: 0 } }));
  const noOverwrite = spawnSync(process.execPath, [cli, 'export', '--run', runId, '--output', first], { cwd: root, encoding: 'utf8' });
  assert.notEqual(noOverwrite.status, 0);
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
