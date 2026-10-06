#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareMeasurements, validateMeasurementReport, exportMeasurement, publishMeasurement } from './benchmark-measurement.mjs';
import { currentFunctionalIdentity } from './benchmark-snapshot.mjs';
import { privateHomeNeverCreated } from './benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME = path.join('benchmarks', 'sentinel-todo', 'runtime');
const BASELINE = path.join('benchmarks', 'sentinel-todo', 'baselines', 'baseline-v1.json');
const MEASUREMENTS = path.join('benchmarks', 'sentinel-todo', 'measurements');
const RUN_MARKER = 'sentinel-todo-run-v2\n';
const CAMPAIGN_MARKER = 'sentinel-todo-campaign-v1\n';
const TERMINAL = new Set(['PASS', 'BLOCKED', 'FAIL', 'ABORTED', 'CANCELLED', 'PAUSED_BUDGET_OR_QUOTA', 'FOCAL_STOP', 'NOT_RUN', 'CAMPAIGN_COMPLETE']);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) => fs.lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });

function blocked(code, detail) {
  const error = new Error(detail);
  error.code = code;
  return error;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw blocked('BLOCKED_BASE', `git ${args[0]}: ${(result.stderr || result.error?.message || 'failed').trim()}`);
  return result.stdout.trim();
}

function realGitState(root) {
  const head = git(root, 'rev-parse', 'HEAD');
  const branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  const upstream = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  const upstreamHead = git(root, 'rev-parse', '@{upstream}');
  if (!upstream.startsWith('origin/') || upstreamHead !== head) {
    throw blocked('BLOCKED_BASE', `HEAD/origin diverged: ${branch} ${head}, ${upstream} ${upstreamHead}`);
  }
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  if (status) throw blocked('BLOCKED_BASE', `working tree is dirty:\n${status}`);
  const diff = git(root, 'diff', '--check');
  if (diff) throw blocked('BLOCKED_BASE', `git diff --check: ${diff}`);
  return { head, branch, upstream };
}

function knownProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw blocked('BLOCKED_PROCESS_CHECK', `cannot inspect processes: ${result.stderr || result.error?.message || 'ps failed'}`);
  const rows = result.stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = byPid.get(pid)?.ppid) ancestors.add(pid);
  return rows.filter((row) => !ancestors.has(row.pid)
    && /(?:^|[\s/])benchmark-(?:manager|campaign|measurement)\.mjs(?:\s|$)|(?:^|[\s/])benchmark\.mjs(?:\s|$)/u.test(row.command));
}

async function assertNoSymlinks(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw blocked('BLOCKED_CLEANUP', `unsafe scratch entry: ${child}`);
    if (stat.isDirectory()) await assertNoSymlinks(child);
  }
}

async function assertSafeScratch(scratch) {
  if (!await exists(scratch)) return;
  const stat = await fs.lstat(scratch);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw blocked('BLOCKED_CLEANUP', `scratch root is not a plain directory: ${scratch}`);
  if (await exists(path.join(scratch, '.active-run.json')) || await exists(path.join(scratch, '.campaign-active.json'))) {
    throw blocked('BLOCKED_ACTIVE', `active or interrupted benchmark marker in ${scratch}`);
  }
  await assertNoSymlinks(scratch);
  for (const entry of await fs.readdir(scratch, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
    const item = path.join(scratch, entry.name);
    if (entry.name === '.turn-ledger.json' && entry.isFile()) continue;
    if (entry.name === '.campaign-state.json' && entry.isFile()) {
      const state = await readJson(item).catch(() => null);
      if (state && ['BLOCKED', 'CANCELLED'].includes(state.status)) continue;
      throw blocked('BLOCKED_CLEANUP', `ambiguous campaign state: ${item}`);
    }
    if (!entry.isDirectory()) throw blocked('BLOCKED_CLEANUP', `unknown scratch entry: ${item}`);
    const isRun = entry.name.startsWith('run-');
    const isCampaign = entry.name.startsWith('campaign-');
    if (!isRun && !isCampaign) throw blocked('BLOCKED_CLEANUP', `unknown scratch directory: ${item}`);
    const marker = path.join(item, isRun ? '.sentinel-benchmark-owned' : '.sentinel-campaign-owned');
    const expected = isRun ? RUN_MARKER : CAMPAIGN_MARKER;
    if (await fs.readFile(marker, 'utf8').catch(() => null) !== expected) throw blocked('BLOCKED_CLEANUP', `unowned scratch directory: ${item}`);
    const state = await readJson(path.join(item, isRun ? 'run.json' : 'state.json')).catch(() => null);
    if (!state || !TERMINAL.has(state.status)) throw blocked('BLOCKED_CLEANUP', `active or ambiguous scratch state: ${item}`);
    if (isRun && !await exists(path.join(item, 'summary.json'))) throw blocked('BLOCKED_CLEANUP', `run has no terminal summary: ${item}`);
    if (isRun) {
      for (const child of await fs.readdir(item, { withFileTypes: true })) {
        if (!child.isDirectory() || !/^case-[a-c]$/u.test(child.name)) continue;
        const caseState = await readJson(path.join(item, child.name, 'case-state.json')).catch(() => null);
        if (!caseState || !TERMINAL.has(caseState.status)) {
          throw blocked('BLOCKED_CLEANUP', `active or ambiguous case state: ${path.join(item, child.name)}`);
        }
      }
    }
  }
}

async function cleanScratch(scratch, stillInactive) {
  await fs.mkdir(scratch, { recursive: true });
  const lock = path.join(scratch, '.campaign-active.json');
  await fs.writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  try {
    await stillInactive();
  async function thaw(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await thaw(path.join(directory, entry.name));
    }
    await fs.chmod(directory, 0o700);
  }
  for (const name of await fs.readdir(scratch)) {
    if (name !== '.campaign-active.json') {
      const item = path.join(scratch, name);
      if ((await fs.lstat(item)).isDirectory()) await thaw(item);
      await fs.rm(item, { recursive: true });
    }
  }
  return lock;
  } catch (error) { await fs.unlink(lock).catch(() => {}); throw error; }
}

async function command(root, relative, args, signal, capture = false) {
  const child = spawn(process.execPath, [path.join(root, relative), ...args], {
    cwd: root, detached: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let stdout = ''; let stderr = '';
  if (capture) { child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); }
  const stop = () => child.kill('SIGINT');
  if (signal.aborted) stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, childSignal) => resolve({ code, childSignal }));
    });
    return { ...result, stdout, stderr };
  } finally { signal.removeEventListener('abort', stop); }
}

function adapters(root) {
  return {
    gitState: () => realGitState(root),
    processes: knownProcesses,
    identity: () => currentFunctionalIdentity(),
    verify: (signal) => command(root, path.join(RUNTIME, 'benchmark.mjs'), ['verify'], signal),
    runFull: (signal) => command(root, path.join(RUNTIME, 'benchmark-manager.mjs'), ['run', '--full'], signal),
    cleanRun: (runId) => command(root, path.join(RUNTIME, 'benchmark-manager.mjs'), ['clean', '--run', runId], new AbortController().signal, true),
    export: (runId, output, signal) => command(root, path.join(RUNTIME, 'benchmark-measurement.mjs'),
      ['export', '--run', runId, '--output', output], signal, true),
    exportMeasurement: (runId) => exportMeasurement(runId),
    publishMeasurement: (report, options) => publishMeasurement(report, options),
    compare: (baseline, report) => compareMeasurements(baseline, report),
  };
}

async function runIds(scratch) {
  return new Set((await fs.readdir(scratch, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('run-')).map((entry) => entry.name));
}

function distribution(reports, getter) {
  const values = reports.map((report, index) => ({ run: index + 1, value: getter(report) }));
  const sampleCount = values.filter(({ value }) => Number.isFinite(value)).length;
  if (sampleCount !== values.length || sampleCount === 0) return { values, sampleCount, median: 'unavailable', min: 'unavailable', max: 'unavailable' };
  const sorted = values.map(({ value }) => value).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { values, sampleCount, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1),
    extremes: { minRuns: values.filter(({ value }) => value === sorted[0]).map(({ run }) => run),
      maxRuns: values.filter(({ value }) => value === sorted.at(-1)).map(({ run }) => run) } };
}

export function campaignSummary({ campaignId, head, startedAt, endedAt, baselineRef, reports, comparisons, plannedRuns }) {
  if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1 || reports.length !== plannedRuns || comparisons.length !== plannedRuns) {
    throw blocked('BLOCKED_SUMMARY', `${plannedRuns} reports and comparisons are required`);
  }
  const a = reports[0];
  const metrics = {
    g2: Object.fromEntries([
      ['operations', (r) => r.aggregate.operations], ['recoveryOperations', (r) => r.aggregate.recoveryOperations],
      ['extraRunnerTurns', (r) => r.aggregate.extraRunnerTurns], ['repeatedReviews', (r) => r.aggregate.repeatedReviewRounds],
      ['repeatedExecuteAttempts', (r) => r.aggregate.repeatedExecuteAttempts],
      ['repeatedValidateAttempts', (r) => r.aggregate.repeatedValidateAttempts],
      ['mainTurns', (r) => r.aggregate.mainTurns], ['runnerTurns', (r) => r.aggregate.runnerTurns],
    ].map(([key, getter]) => [key, distribution(reports, getter)])),
    g3: Object.fromEntries([
      ['mainInput', (r) => r.aggregate.telemetry.main?.input], ['mainOutput', (r) => r.aggregate.telemetry.main?.output],
      ['runnerInput', (r) => r.aggregate.telemetry.runner?.input], ['runnerOutput', (r) => r.aggregate.telemetry.runner?.output],
      ['peakInputPerTurn', (r) => r.aggregate.telemetry.peakInputPerTurn],
      ['medianInputPerTurn', (r) => r.aggregate.telemetry.medianInputPerTurn],
    ].map(([key, getter]) => [key, distribution(reports, getter)])),
  };
  return { schemaVersion: 1, campaignId, benchmarkId: a.benchmarkId, benchmarkVersion: a.benchmarkVersion,
    baseline: baselineRef, head, profile: a.run.profile,
    sourceFunctionalSha256: a.provenance.sourceFunctionalSha256, startedAt, endedAt,
    status: 'CAMPAIGN_COMPLETE', comparability: 'PASS', plannedRuns, completedRuns: reports.length, successRate: 1,
    runs: reports.map((report, index) => ({ index: index + 1, runId: report.run.id, status: report.run.status,
      cases: Object.fromEntries(report.cases.map((row) => [row.id, row.status])),
      operations: report.aggregate.operations, mainTurns: report.aggregate.mainTurns, runnerTurns: report.aggregate.runnerTurns,
      recoveryOperations: report.aggregate.recoveryOperations, wallDurationMs: report.aggregate.wallDurationMs,
      telemetryCoverage: report.aggregate.telemetry.coverage,
      g2: { operations: report.aggregate.operations, recoveryOperations: report.aggregate.recoveryOperations,
        extraRunnerTurns: report.aggregate.extraRunnerTurns, repeatedReviews: report.aggregate.repeatedReviewRounds,
        repeatedExecuteAttempts: report.aggregate.repeatedExecuteAttempts, repeatedValidateAttempts: report.aggregate.repeatedValidateAttempts },
      g3: { main: report.aggregate.telemetry.main, runner: report.aggregate.telemetry.runner,
        peakInputPerTurn: report.aggregate.telemetry.peakInputPerTurn,
        medianInputPerTurn: report.aggregate.telemetry.medianInputPerTurn }, comparisonToBaseline: comparisons[index] })),
    distribution: { ...metrics, wallDurationMs: distribution(reports, (r) => r.aggregate.wallDurationMs),
      outliers: 'All individual values and extremes are retained; no run is excluded.' },
    gateDecision: { G2: 'PENDING', G3: 'PENDING' } };
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function promote(root, campaignId, files, signal) {
  const parent = path.join(root, MEASUREMENTS);
  const destination = path.join(parent, campaignId);
  if (await exists(destination)) throw blocked('BLOCKED_DESTINATION', `measurement destination already exists: ${destination}`);
  await fs.mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.${campaignId}-${randomUUID()}-stage`);
  await fs.mkdir(stage);
  try {
    for (const [name, source] of Object.entries(files)) await fs.copyFile(source, path.join(stage, name), fs.constants.COPYFILE_EXCL);
    if (signal.aborted) throw blocked('CANCELLED', 'campaign interrupted before promotion');
    if (await exists(destination)) throw blocked('BLOCKED_DESTINATION', `measurement destination already exists: ${destination}`);
    await fs.rename(stage, destination);
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
  return destination;
}

export async function runCampaign({ root = ROOT, hooks = {}, campaignId = null } = {}) {
  if (process.env.STNL_OFFLINE_PROVIDER_CONTEXT !== undefined) throw blocked('BLOCKED_BASE', 'TEST-ONLY provider cannot enter a formal campaign');
  const api = { ...adapters(root), ...hooks };
  const scratch = path.join(root, 'benchmark-temp');
  const signal = new AbortController();
  const onSignal = () => signal.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let lock = null; let campaignRoot = null; let index = 0; let runId = null;
  const say = (line) => console.log(line);
  const checkCancel = () => { if (signal.signal.aborted) throw blocked('CANCELLED', 'campaign interrupted'); };
  try {
    say('PRECHECK');
    const base = await api.gitState();
    const baselineBytes = await fs.readFile(path.join(root, BASELINE));
    const baseline = validateMeasurementReport(JSON.parse(baselineBytes));
    if (baseline.baselineVersion !== 1 || baseline.run.status !== 'PASS') throw blocked('BLOCKED_BASELINE', 'baseline-v1 is invalid');
    const manifest = await readJson(path.join(root, 'benchmarks/sentinel-todo/benchmark.json'));
    const plannedRuns = manifest.campaign?.fullRuns;
    if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1) throw blocked('BLOCKED_CONFIG', 'campaign.fullRuns must be a positive integer');
    if (manifest.benchmarkVersion !== baseline.benchmarkVersion || manifest.productionProfile?.id !== baseline.run.profile) {
      throw blocked('BLOCKED_BASELINE', 'baseline and manifest version/profile differ');
    }
    if ((await api.processes()).length) throw blocked('BLOCKED_ACTIVE', 'another benchmark process is alive');
    await assertSafeScratch(scratch);
    checkCancel();
    say('CLEAN');
    lock = await cleanScratch(scratch, async () => {
      if (await exists(path.join(scratch, '.active-run.json')) || (await api.processes()).length) {
        throw blocked('BLOCKED_ACTIVE', 'benchmark became active before cleanup');
      }
    });
    checkCancel();
    say('VERIFY');
    const verified = await api.verify(signal.signal);
    checkCancel();
    if (verified.code !== 0) throw blocked('BLOCKED_VERIFY', `benchmark verify failed (${verified.code})`);
    const id = campaignId ?? `campaign-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    if (!/^campaign-[a-z0-9-]{8,}$/u.test(id)) throw blocked('BLOCKED_DESTINATION', 'invalid campaign ID');
    const destination = path.join(root, MEASUREMENTS, id);
    if (await exists(destination)) throw blocked('BLOCKED_DESTINATION', `measurement destination already exists: ${destination}`);
    campaignRoot = path.join(scratch, id);
    await fs.mkdir(campaignRoot);
    await fs.writeFile(path.join(campaignRoot, '.sentinel-campaign-owned'), CAMPAIGN_MARKER, { flag: 'wx' });
    const startedAt = new Date().toISOString();
    const source = await api.identity();
    const reports = []; const comparisons = []; const files = {};
    const baselineRef = { path: BASELINE, runId: baseline.run.id,
      sha256: `sha256:${createHash('sha256').update(baselineBytes).digest('hex')}` };
    for (index = 1; index <= plannedRuns; index += 1) {
      checkCancel();
      if ((await api.gitState()).head !== base.head || (await api.identity()).sha256 !== source.sha256) {
        throw blocked('CAMPAIGN_SOURCE_DRIFT', `checkout or functional source changed before run ${index}`);
      }
      say(`RUN ${index}/${plannedRuns}`);
      const before = await runIds(scratch);
      const result = await api.runFull(signal.signal);
      const created = [...await runIds(scratch)].filter((item) => !before.has(item));
      if (created.length !== 1) throw blocked('BLOCKED_RUN_ID', `run ${index} created ${created.length} run directories`);
      runId = created[0];
      const runRoot = path.join(scratch, runId);
      const run = await readJson(path.join(runRoot, 'run.json'));
      const summary = await readJson(path.join(runRoot, 'summary.json')).catch(() => null);
      checkCancel();
      if (result.code !== 0 || run.runId !== runId || run.mode !== 'full' || run.status !== 'PASS'
        || summary?.status !== 'PASS' || ['A', 'B', 'C'].some((key) => summary.cases?.[key]?.status !== 'PASS')) {
        const cases = Object.entries(summary?.cases ?? {}).map(([key, value]) => `${key}:${value.status}${value.terminal?.blocker ? `/${value.terminal.blocker}` : ''}`).join(', ');
        throw blocked('BLOCKED_RUN', `run ${index} ${runId} ${run.status}; cases ${cases || 'unavailable'}; raw ${runRoot}`);
      }
      if (run.snapshot?.sourceFunctionalSha256 !== source.sha256 || (await api.identity()).sha256 !== source.sha256) {
        throw blocked('CAMPAIGN_SOURCE_DRIFT', `functional source changed in run ${index}; raw ${runRoot}`);
      }
      say(`EXPORT ${index}/${plannedRuns}`);
      const name = `run-${String(index).padStart(2, '0')}.json`;
      const file = path.join(campaignRoot, name);
      const exported = await api.export(runId, file, signal.signal);
      checkCancel();
      if (exported.code !== 0) throw blocked('BLOCKED_EXPORT', `run ${index} ${runId}: ${exported.stderr || exported.code}`);
      const report = validateMeasurementReport(await readJson(file));
      if (report.run.id !== runId || report.run.status !== 'PASS' || report.run.profile !== manifest.productionProfile.id
        || report.provenance.sourceFunctionalSha256 !== source.sha256
        || report.cases.length !== 3 || ['A', 'B', 'C'].some((key) => report.cases.find((row) => row.id === key)?.status !== 'PASS')) {
        throw blocked('BLOCKED_REPORT', `run ${index} ${runId}: invalid campaign report`);
      }
      say(`COMPARE ${index}/${plannedRuns}`);
      const comparison = await api.compare(baseline, report);
      if (!comparison.directlyComparable || comparison.profileExperiment || comparison.mismatches?.length) {
        throw blocked('BLOCKED_COMPARABILITY', `run ${index} ${runId}: ${comparison.mismatches?.join(', ') || 'not directly comparable'}`);
      }
      await writeJson(path.join(campaignRoot, `compare-${String(index).padStart(2, '0')}.json`), comparison);
      reports.push(report); comparisons.push(comparison); files[name] = file;
      runId = null;
    }
    if ((await api.gitState()).head !== base.head || (await api.identity()).sha256 !== source.sha256) {
      throw blocked('CAMPAIGN_SOURCE_DRIFT', 'checkout or functional source changed before promotion');
    }
    index = plannedRuns;
    checkCancel();
    say('SUMMARY');
    const campaign = campaignSummary({ campaignId: id, head: base.head, startedAt, endedAt: new Date().toISOString(),
      baselineRef, reports, comparisons, plannedRuns });
    files['campaign-summary.json'] = path.join(campaignRoot, 'campaign-summary.json');
    await writeJson(files['campaign-summary.json'], campaign);
    checkCancel();
    say('PROMOTE');
    const promoted = await promote(root, id, files, signal.signal);
    await writeJson(path.join(campaignRoot, 'state.json'),
      { status: 'CAMPAIGN_COMPLETE', campaignId: id, endedAt: campaign.endedAt }).catch((error) => {
      console.error(`scratch status could not be written: ${error.message}`);
    });
    say(`CAMPAIGN_COMPLETE ${id}: ${plannedRuns}/${plannedRuns} PASS`);
    say(`reports: ${path.relative(root, promoted)}`);
    say(`raws: ${path.relative(root, scratch)}`);
    say('next: review and commit the reports; do not rerun this campaign');
    return campaign;
  } catch (error) {
    const status = signal.signal.aborted ? 'CANCELLED' : error.code ?? 'BLOCKED';
    if (campaignRoot) await writeJson(path.join(campaignRoot, 'state.json'),
      { status: status === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', blockerCode: status,
        runIndex: index, runId, blocker: error.message, endedAt: new Date().toISOString() }).catch(() => {});
    else if (lock) await writeJson(path.join(scratch, '.campaign-state.json'),
      { status: status === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', blockerCode: status,
        blocker: error.message, endedAt: new Date().toISOString() }).catch(() => {});
    console.error(`${status}: run ${index || '-'} ${runId ?? '-'}; ${error.message}`);
    if (campaignRoot) console.error(`evidence: ${campaignRoot}`);
    throw error;
  } finally {
    if (lock) await fs.unlink(lock).catch(() => {});
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

// The default npm command is deliberately a single functional run. The formal
// campaign above remains opt-in through `npm run benchmark:campaign`.
export async function runFunctionalBenchmark({ root = ROOT, hooks = {} } = {}) {
  const api = { ...adapters(root), ...hooks };
  const scratch = path.join(root, 'benchmark-temp');
  const signal = new AbortController();
  const onSignal = () => signal.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let lock = null;
  const reportRoot = path.join(root, 'benchmarks', 'sentinel-todo', 'measurements');
  const say = (line) => console.log(line);
  const checkCancel = () => { if (signal.signal.aborted) throw blocked('CANCELLED', 'benchmark interrupted'); };
  async function preserveReport(report, updateLatest = false) {
    if (report?.run?.id === undefined) throw new Error('report has no run identity');
    if (!['full', 'case', 'focal'].includes(report.run.mode)) throw new Error('report has no supported run mode');
    if (report.run.mode !== 'full') return true;
    // The publisher validates byte-identical history collisions and refreshes
    // latest when requested, so an existing ID cannot silently hide new data.
    await api.publishMeasurement(report, { root: reportRoot, updateLatest });
    return true;
  }
  async function preserve(runId) {
    try {
      const report = await api.exportMeasurement(runId);
      if (report?.run?.id !== runId) throw new Error(`exported report identity mismatch for ${runId}`);
      return await preserveReport(report);
    } catch (error) {
      console.error(`report for ${runId} was not preserved; raw evidence retained: ${error.message}`);
      return false;
    }
  }
  try {
    say('VERIFY');
    const verified = await api.verify(signal.signal);
    checkCancel();
    if (verified.code !== 0) throw blocked('BLOCKED_VERIFY', `benchmark verify failed (${verified.code})`);
    await fs.mkdir(scratch, { recursive: true });
    const scratchStat = await fs.lstat(scratch);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) throw blocked('BLOCKED_CLEANUP', `scratch root is unsafe: ${scratch}`);
    if ((await api.processes()).length) throw blocked('BLOCKED_ACTIVE', 'another benchmark process is alive');
    if (await exists(path.join(scratch, '.active-run.json')) || await exists(path.join(scratch, '.campaign-active.json')))
      throw blocked('BLOCKED_ACTIVE', `active or interrupted benchmark marker in ${scratch}`);
    await assertNoSymlinks(scratch);
    if (await exists(path.join(scratch, '.campaign-state.json'))) {
      const state = await readJson(path.join(scratch, '.campaign-state.json')).catch(() => null);
      if (!state || !TERMINAL.has(state.status)) throw blocked('BLOCKED_CLEANUP', 'ambiguous campaign state at scratch root');
    }
    if (await exists(path.join(scratch, '.turn-ledger.json')) && !(await fs.lstat(path.join(scratch, '.turn-ledger.json'))).isFile())
      throw blocked('BLOCKED_CLEANUP', 'turn ledger is not a regular file');
    for (const entry of await fs.readdir(scratch, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')
        || entry.name === '.turn-ledger.json' || entry.name === '.campaign-state.json') continue;
      const item = path.join(scratch, entry.name);
      if (!entry.isDirectory()) throw blocked('BLOCKED_CLEANUP', `unknown scratch entry: ${item}`);
      if (entry.name.startsWith('run-')) {
        if (await fs.readFile(path.join(item, '.sentinel-benchmark-owned'), 'utf8').catch(() => null) !== RUN_MARKER)
          throw blocked('BLOCKED_CLEANUP', `unowned scratch directory: ${item}`);
        const run = await readJson(path.join(item, 'run.json')).catch(() => null);
        const summary = await readJson(path.join(item, 'summary.json')).catch(() => null);
        if (!run || run.runId !== entry.name || !['full', 'case', 'focal'].includes(run.mode) || !TERMINAL.has(run.status)
          || !Array.isArray(run.cases) || run.cases.length === 0 || new Set(run.cases).size !== run.cases.length
          || run.cases.some((id) => !['A', 'B', 'C'].includes(id)) || (run.mode !== 'full' && run.cases.length !== 1)
          || !summary || summary.runId !== run.runId || summary.mode !== run.mode
          || summary.status !== run.status || !TERMINAL.has(summary.status))
          throw blocked('BLOCKED_CLEANUP', `active or ambiguous scratch state: ${item}`);
        for (const caseId of run.cases) {
          const result = summary.cases?.[caseId];
          if (!result || !TERMINAL.has(result.status)
            || (result.status !== 'NOT_RUN' && !await exists(path.join(item, `case-${caseId.toLowerCase()}`)))) {
            throw blocked('BLOCKED_CLEANUP', `missing or ambiguous case identity: ${item}/${caseId}`);
          }
        }
        for (const child of await fs.readdir(item, { withFileTypes: true })) {
          if (!child.isDirectory() || !/^case-[a-c]$/u.test(child.name)) continue;
          const caseRoot = path.join(item, child.name);
          const state = await readJson(path.join(caseRoot, 'case-state.json')).catch(() => null);
          if (!state || state.caseId !== child.name.slice(5).toUpperCase() || !run.cases.includes(state.caseId)
            || !TERMINAL.has(state.status) || summary.cases?.[state.caseId]?.status !== state.status
            || (state.privateHomeRemoved !== true && !(state.privateHomeSuspended === true && state.suspendedHome)
              && !privateHomeNeverCreated(state, await readJson(path.join(caseRoot, 'journal.json')).catch(() => null))))
            throw blocked('BLOCKED_CLEANUP', `active or ambiguous case state: ${caseRoot}`);
        }
      } else if (entry.name.startsWith('campaign-')) {
        if (await fs.readFile(path.join(item, '.sentinel-campaign-owned'), 'utf8').catch(() => null) !== CAMPAIGN_MARKER)
          throw blocked('BLOCKED_CLEANUP', `unowned scratch directory: ${item}`);
        const state = await readJson(path.join(item, 'state.json')).catch(() => null);
        if (!state || !TERMINAL.has(state.status)) throw blocked('BLOCKED_CLEANUP', `active or ambiguous campaign state: ${item}`);
        for (const child of await fs.readdir(item, { withFileTypes: true })) {
          if (child.name === '.DS_Store' || child.name === '__MACOSX' || child.name.startsWith('._')) continue;
          if (!child.isFile() || !new Set(['.sentinel-campaign-owned', 'state.json', 'campaign-summary.json'])
            .has(child.name) && !/^run-\d+\.json$/u.test(child.name) && !/^compare-\d+\.json$/u.test(child.name))
            throw blocked('BLOCKED_CLEANUP', `unknown campaign scratch entry: ${path.join(item, child.name)}`);
        }
      } else throw blocked('BLOCKED_CLEANUP', `unknown scratch directory: ${item}`);
    }
    checkCancel();
    const lockPath = path.join(scratch, '.campaign-active.json');
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    lock = lockPath;
    if (await exists(path.join(scratch, '.active-run.json')) || (await api.processes()).length)
      throw blocked('BLOCKED_ACTIVE', 'benchmark became active before cleanup');
    // Preserve terminal report files before removing old campaign scratch.
    for (const entry of await fs.readdir(scratch, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const item = path.join(scratch, entry.name);
      if (entry.name.startsWith('run-')) {
        const run = await readJson(path.join(item, 'run.json'));
        const saved = run.mode === 'full' ? await preserve(run.runId ?? entry.name) : true;
        if (run.mode !== 'full') say(`SKIP MEASUREMENT ${run.runId}: ${run.mode}`);
        if (!saved) throw blocked('BLOCKED_CLEANUP', `report preservation failed for ${entry.name}; scratch retained`);
        if (await exists(path.join(scratch, '.active-run.json')) || (await api.processes()).length)
          throw blocked('BLOCKED_ACTIVE', 'benchmark became active during report preservation');
        const cleaned = await api.cleanRun(run.runId);
        if (cleaned.code !== 0) throw blocked('BLOCKED_CLEANUP', `manager cleanup retained ${entry.name}: ${cleaned.stderr || cleaned.code}`);
      } else if (entry.name.startsWith('campaign-')) {
        let safeToRemove = true;
        for (const child of await fs.readdir(item, { withFileTypes: true })) {
          if (child.isFile() && /^run-\d+\.json$/u.test(child.name)) {
            const report = await readJson(path.join(item, child.name)).catch(() => null);
            try { if (!report?.run?.id) throw new Error('missing report identity'); await preserveReport(report); }
            catch (error) { safeToRemove = false; console.error(`campaign report ${child.name} retained in scratch: ${error.message}`); }
          }
        }
        if (safeToRemove) {
          const summaryFile = path.join(item, 'campaign-summary.json');
          if (await exists(summaryFile)) {
            try {
              const archive = path.join(reportRoot, entry.name);
              await fs.mkdir(archive, { recursive: true });
              const archivedSummary = path.join(archive, 'campaign-summary.json');
              if (await exists(archivedSummary)) {
                if (!Buffer.from(await fs.readFile(archivedSummary)).equals(await fs.readFile(summaryFile))) safeToRemove = false;
              } else await fs.copyFile(summaryFile, archivedSummary, fs.constants.COPYFILE_EXCL);
            } catch (error) { safeToRemove = false; console.error(`campaign summary retained in scratch: ${error.message}`); }
          }
          if (safeToRemove) {
            if (await exists(path.join(scratch, '.active-run.json')) || (await api.processes()).length)
              throw blocked('BLOCKED_ACTIVE', 'benchmark became active during campaign preservation');
            await fs.rm(item, { recursive: true });
          }
        }
        if (!safeToRemove) throw blocked('BLOCKED_CLEANUP', `campaign preservation failed for ${entry.name}; scratch retained`);
      }
    }
    for (const name of await fs.readdir(scratch)) {
      if (name === '.campaign-active.json' || name === '.active-run.json') continue;
      if (name === '.turn-ledger.json' || name === '.campaign-state.json' || name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')) {
        const target = path.join(scratch, name);
        if ((await fs.lstat(target)).isDirectory()) await fs.rm(target, { recursive: true });
        else await fs.unlink(target);
      }
    }
    checkCancel();
    if ((await api.processes()).length || await exists(path.join(scratch, '.active-run.json')))
      throw blocked('BLOCKED_ACTIVE', 'benchmark activity detected before full run');
    say('RUN FULL');
    const before = await runIds(scratch);
    const result = await api.runFull(signal.signal);
    const created = [...await runIds(scratch)].filter((item) => !before.has(item));
    if (created.length !== 1) throw blocked('BLOCKED_RUN_ID', `full run created ${created.length} run directories`);
    const runId = created[0];
    const runRoot = path.join(scratch, runId);
    const run = await readJson(path.join(runRoot, 'run.json')).catch(() => null);
    const summary = await readJson(path.join(runRoot, 'summary.json')).catch(() => null);
    const status = signal.signal.aborted ? 'CANCELLED' : (run?.status ?? 'UNAVAILABLE');
    try {
      const report = await api.exportMeasurement(runId);
      if (report?.run?.id !== runId) throw new Error(`exported report identity mismatch for ${runId}`);
      if (report.run.mode !== 'full') throw new Error('current benchmark report must be full');
      await preserveReport(report, true);
    } catch (error) {
      console.error(`report for ${runId} was not published; raw evidence retained: ${error.message}`);
      const failure = blocked(status, `run ${runId} outcome ${status}; cases ${JSON.stringify(summary?.cases ?? null)}; manager exit ${result.code}; report publication failed: ${error.message}; raw evidence retained at ${runRoot}`);
      failure.exitCode = result.code || 1;
      throw failure;
    }
    if (result.code !== 0 || status !== 'PASS') {
      const failure = blocked(status, `run ${runId} outcome ${status}; cases ${JSON.stringify(summary?.cases ?? null)}; manager exit ${result.code}; raw evidence ${runRoot}`);
      failure.exitCode = result.code || 1;
      throw failure;
    }
    say(`PASS ${runId}; report published`);
    return { runId, status, cases: summary?.cases ?? null };
  } catch (error) {
    console.error(`${error.code ?? 'BLOCKED'}: ${error.message}`);
    throw error;
  } finally {
    if (lock) await fs.unlink(lock).catch(() => {});
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--help')) {
    const config = await readJson(path.join(ROOT, 'benchmarks/sentinel-todo/benchmark.json'));
    console.log(`Functional single run: npm run benchmark\nFormal ${config.campaign.fullRuns}-full campaign: npm run benchmark:campaign`);
  }
  else if (process.argv.length === 3 && process.argv[2] === '--functional') runFunctionalBenchmark().catch((error) => { process.exitCode = error.exitCode ?? 1; });
  else if (process.argv.length !== 2) { console.error('usage: npm run benchmark:campaign | benchmark-campaign.mjs --functional'); process.exitCode = 2; }
  else runCampaign().catch(() => { process.exitCode = 1; });
}
