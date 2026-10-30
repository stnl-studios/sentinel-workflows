#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { measurementCompleteness, validateMeasurementReport } from './benchmark-measurement.mjs';
import { privateHomeNeverCreated, settledNativeCase, settledNativeCleanupCase } from './benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME = path.join('benchmarks', 'sentinel-todo', 'runtime');
const BASELINE = path.join('benchmarks', 'sentinel-todo', 'baselines', 'baseline-v1.json');
const MEASUREMENTS = path.join('benchmarks', 'sentinel-todo', 'measurements');
const RUN_MARKER = 'sentinel-todo-run-v2\n';
const CAMPAIGN_MARKER = 'sentinel-todo-campaign-v1\n';
const MAX_FUNCTIONAL_RUNS = 3;
const TERMINAL = new Set(['PASS', 'BLOCKED', 'FAIL', 'ABORTED', 'CANCELLED', 'PAUSED_BUDGET_OR_QUOTA', 'FOCAL_STOP', 'RECOVERY_STOP', 'NOT_RUN', 'CAMPAIGN_COMPLETE', 'FUNCTIONAL_ACCEPTED', 'FUNCTIONAL_ROUNDS_PARTIAL']);
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
  // A local frozen candidate need not already be pushed. This optional cached
  // reference is information, never a remote freshness or publication proof.
  const reference = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (reference.error || /permission denied|operation not permitted/iu.test(reference.stderr ?? ''))
    throw blocked('BLOCKED_BASE', `cannot read cached upstream: ${reference.error?.message ?? reference.stderr}`);
  const upstream = reference.status === 0 ? reference.stdout.trim() : 'unavailable';
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  if (status) throw blocked('BLOCKED_BASE', `working tree is dirty:\n${status}`);
  const diff = git(root, 'diff', '--check');
  if (diff) throw blocked('BLOCKED_BASE', `git diff --check: ${diff}`);
  return { head, branch, upstream };
}

export function isOwnedNativeAppServerCommand(command, root = ROOT) {
  const scratchRoot = `${path.resolve(root, 'benchmark-temp')}${path.sep}`;
  const launcherSuffix = [
    'snapshot', 'agents', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js',
  ].join(path.sep);
  return typeof command === 'string' && command.includes(scratchRoot)
    && command.includes(`${path.sep}${launcherSuffix}`)
    && command.includes(' app-server --listen stdio://');
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
    && (/(?:^|[\s/])benchmark-(?:manager|campaign|measurement)\.mjs(?:\s|$)|(?:^|[\s/])benchmark\.mjs(?:\s|$)/u.test(row.command)
      || isOwnedNativeAppServerCommand(row.command)));
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

async function acquireCampaignLock(scratch, stillInactive) {
  await fs.mkdir(scratch, { recursive: true });
  const metadata = await fs.lstat(scratch);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw blocked('BLOCKED_CLEANUP', 'scratch root is unsafe');
  const lock = path.join(scratch, '.campaign-active.json');
  await fs.writeFile(lock, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  try {
    await stillInactive();
  // Starting a campaign does not authorize deleting other runs, ledgers or raw
  // diagnostics. Only this invocation's temporary lock is owned here.
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
  // Recovery control may be newer; all measurement readers and managers remain
  // those of the explicitly selected, unchanged measured checkout.
  const measured = name => import(pathToFileURL(path.join(root, RUNTIME, name)).href);
  return {
    gitState: () => realGitState(root),
    processes: knownProcesses,
    identity: async () => (await measured('benchmark-snapshot.mjs')).currentFunctionalIdentity(),
    snapshot: async id => (await measured('benchmark-snapshot.mjs')).assertSnapshotIntegrity(path.join(root,'benchmark-temp',id)),
    isProcessAlive: pid => { try { process.kill(pid,0); return true; } catch(error) { if(error.code==='ESRCH')return false; throw error; } },
    recoveryVersion: async () => ({head:realGitState(ROOT).head,sha256:digest(await fs.readFile(fileURLToPath(import.meta.url)))}),
    verify: (signal) => command(root, path.join(RUNTIME, 'benchmark.mjs'), ['verify'], signal),
    runFull: (signal,{maxOperations}={}) => command(root, path.join(RUNTIME, 'benchmark-manager.mjs'),
      ['run', '--full',...(maxOperations===undefined?[]:['--max-operations',String(maxOperations)])], signal),
    resumeFull: (id,signal,{maxOperations}={}) => command(root,path.join(RUNTIME,'benchmark-manager.mjs'),
      ['run','--resume',id,...(maxOperations===undefined?[]:['--max-operations',String(maxOperations)])],signal),
    preflightFullResume: async id => (await measured('benchmark-manager.mjs')).preflightFullResume(id),
    cleanRun: (runId) => command(root, path.join(RUNTIME, 'benchmark-manager.mjs'), ['clean', '--run', runId], new AbortController().signal, true),
    export: (runId, output, signal) => command(root, path.join(RUNTIME, 'benchmark-measurement.mjs'),
      ['export', '--run', runId, '--output', output], signal, true),
    exportMeasurement: async runId => (await measured('benchmark-measurement.mjs')).exportMeasurement(runId),
    compare: async (baseline, report) => (await measured('benchmark-measurement.mjs')).compareMeasurements(baseline, report),
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

export function campaignSummary({ campaignId, head, startedAt, endedAt, baselineRef, reports, comparisons, plannedRuns, recovery = null }) {
  if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1 || reports.length !== plannedRuns || comparisons.length !== plannedRuns) {
    throw blocked('BLOCKED_SUMMARY', `${plannedRuns} reports and comparisons are required`);
  }
  const a = reports[0];
  if (new Set(reports.map(report => report?.run?.id)).size !== plannedRuns
    || reports.some(report => report?.run?.status !== 'PASS' || report.run.mode !== 'full'
      || report.run.profile !== a.run.profile || report.benchmarkVersion !== a.benchmarkVersion
      || report.provenance?.sourceFunctionalSha256 !== a.provenance?.sourceFunctionalSha256
      || !Array.isArray(report.cases) || report.cases.map(row => row.id).sort().join() !== 'A,B,C'
      || report.cases.some(row => row.status !== 'PASS'))) {
    throw blocked('BLOCKED_SUMMARY', 'N distinct coherent passing FULLs are required');
  }
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
    ...(recovery?{controlRecovery:{contract:recovery.contract,controller:recovery.controller,recoveredAt:recovery.recoveredAt,
      originalStateSha256:recovery.originalStateSha256,binding:recovery.binding,managerExit:null,campaignExit:null}}:{}),
    status: 'CAMPAIGN_COMPLETE', comparability: comparisons.every(row => row.directlyComparable && !row.profileExperiment) ? 'PASS' : 'unavailable', plannedRuns, completedRuns: reports.length, successRate: 1,
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
async function updateCampaignState(file,value) {
  const {stateSha256,...body}=value;
  value={...body,stateSha256:digest(JSON.stringify(body))};
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o600});
  await fs.rename(temporary,file);
}
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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

// This is a stop-only recovery of local control records, never a producer retry.
// A missing process exit stays unknown; complete measured evidence is revalidated
// under the explicitly approved recovery contract instead of inventing exit 0.
export async function recoverCompletedCampaign({root=ROOT,campaignId,hooks={}}={}) {
  if(!/^campaign-[a-z0-9-]{8,}$/u.test(campaignId??'')
    ||path.resolve(root)!==await fs.realpath(root))throw blocked('BLOCKED_RECOVERY','invalid measured root or campaign');
  const api={...adapters(root),...hooks},scratch=path.join(root,'benchmark-temp');
  const dir=path.join(scratch,campaignId),stateFile=path.join(dir,'state.json');
  const plain=async file=>{const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw blocked('BLOCKED_RECOVERY','control is not a plain file');
    return fs.readFile(file);};
  const meta=await fs.lstat(dir);
  if(!meta.isDirectory()||meta.isSymbolicLink()
    ||(await plain(path.join(dir,'.sentinel-campaign-owned'))).toString()!==CAMPAIGN_MARKER)
    throw blocked('BLOCKED_RECOVERY','campaign ownership differs');
  // Reuse the manager's existing exclusion point. This is explicitly control
  // recovery, not a model admission or a fabricated active producer run.
  const activeLock=path.join(scratch,'.active-run.json');
  // A live controller must not even see a transient recovery exclusion between
  // its FULLs. Check before claiming, then check again under the owned lock.
  if((await api.processes()).length)throw blocked('BLOCKED_ACTIVE','campaign or recorded controller is still alive');
  const markerBefore=path.join(scratch,'.campaign-active.json');
  if(await exists(markerBefore)) {
    const ownerBefore=JSON.parse(await plain(markerBefore));
    if(!Number.isSafeInteger(ownerBefore.pid)||ownerBefore.pid<1)throw blocked('BLOCKED_RECOVERY','invalid controller marker');
    if(await api.isProcessAlive(ownerBefore.pid))throw blocked('BLOCKED_ACTIVE','campaign or recorded controller is still alive');
  }
  const activeBytes=Buffer.from(JSON.stringify({kind:'campaign-recovery',campaignId,runId:null,
    pid:process.pid,token:randomUUID(),startedAt:new Date().toISOString()})+'\n');
  try {await fs.writeFile(activeLock,activeBytes,{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')throw blocked('BLOCKED_ACTIVE','another run or recovery owns the existing lock');throw error;}
  try {
  const originalBytes=await plain(stateFile),current=JSON.parse(originalBytes);
  const sealed=value=>{const {stateSha256,...body}=value;return stateSha256===digest(JSON.stringify(body));};
  const replay=current.status==='RECOVERY_STOP';
  const state=replay?JSON.parse(current.recovery?.originalStateBytes??'null'):current;
  if(!sealed(current)||!state||!sealed(state)||state.status!=='ACTIVE'||state.campaignId!==campaignId
    ||!Array.isArray(state.completed)||state.completed.length!==0||state.runIndex!==1||state.runId!==null
    ||state.pendingCheckpoint!==null||!Number.isFinite(Date.parse(state.startedAt)))
    throw blocked('BLOCKED_RECOVERY','not an exclusive uncheckpointed first FULL');
  // With no pre-dispatch runId in the old state, only an otherwise empty,
  // single-campaign/single-run scratch can establish an unambiguous binding.
  const dirs=(await fs.readdir(scratch,{withFileTypes:true})).filter(x=>x.isDirectory());
  const runs=dirs.filter(x=>x.name.startsWith('run-'));
  if(dirs.length!==2||runs.length!==1||dirs.filter(x=>x.name.startsWith('campaign-')).some(x=>x.name!==campaignId)
    ||!/^run-[a-z0-9-]+$/u.test(runs[0]?.name??''))throw blocked('BLOCKED_RECOVERY','ambiguous run origin');
  const runId=runs[0].name,runRoot=path.join(scratch,runId);
  await assertNoSymlinks(scratch);
  if(await fs.readFile(path.join(dir,'.sentinel-campaign-owned'),'utf8')!==CAMPAIGN_MARKER
    ||await fs.readFile(path.join(runRoot,'.sentinel-benchmark-owned'),'utf8')!==RUN_MARKER
    )throw blocked('BLOCKED_RECOVERY','ownership differs');
  const freeze=state.freeze,manifest=await readJson(path.join(root,'benchmarks/sentinel-todo/benchmark.json'));
  const base=await api.gitState(),source=await api.identity();
  if(!freeze||freeze.head!==base.head||freeze.sourceFunctionalSha256!==source.sha256
    ||freeze.configurationSha256!==digest(JSON.stringify(manifest))||!Number.isSafeInteger(freeze.plannedRuns)
    ||freeze.plannedRuns<1)throw blocked('BLOCKED_RECOVERY','measured freeze differs');
  const marker=path.join(scratch,'.campaign-active.json');
  const markerBytes=await exists(marker)?await plain(marker):null;
  const initialMarker=replay?current.recovery?.originalMarkerBytes:markerBytes?.toString();
  const owner=JSON.parse(initialMarker??'null');
  if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<1||!Number.isFinite(Date.parse(owner.startedAt))
    ||Date.parse(owner.startedAt)>Date.parse(state.startedAt))throw blocked('BLOCKED_RECOVERY','missing original controller marker');
  const inactive=async()=>{
    if((await api.processes()).length||await api.isProcessAlive(owner.pid))
      throw blocked('BLOCKED_ACTIVE','campaign or recorded controller is still alive');
    if(!activeBytes.equals(await plain(activeLock)))throw blocked('BLOCKED_ACTIVE','recovery exclusion was lost');
  };
  await inactive();
  if(markerBytes&&markerBytes.toString()!==initialMarker)throw blocked('BLOCKED_RECOVERY','controller marker changed');
  const controls=new Map();
  const control=async relative=>{const bytes=await plain(path.join(runRoot,relative));controls.set(relative,bytes);return JSON.parse(bytes);};
  const run=await control('run.json'),summary=await control('summary.json'),ledger=await control('.turn-ledger.json');
  const snapshot=await api.snapshot(runId);
  if(run.runId!==runId||!isDeepStrictEqual(run.cases,['A','B','C'])||run.mode!=='full'||run.status!=='PASS'||run.profile!==manifest.productionProfile.id
    ||run.snapshot?.baseSha!==base.head||!isDeepStrictEqual(run.snapshot,snapshot)
    ||run.snapshot.sourceFunctionalSha256!==source.sha256||run.configurationSha256!==freeze.configurationSha256
    ||run.controllerSha256!==digest(await plain(path.join(root,RUNTIME,'benchmark-manager.mjs')))
    ||Date.parse(run.startedAt)<Date.parse(state.startedAt)||!Number.isFinite(Date.parse(run.startedAt))
    ||!Number.isFinite(Date.parse(run.endedAt))||Date.parse(run.endedAt)<Date.parse(run.startedAt)
    ||summary.runId!==runId||summary.mode!=='full'||summary.status!=='PASS'
    ||summary.snapshotSha256!==snapshot.snapshotSha256||summary.sourceFunctionalSha256!==source.sha256
    ||ledger.limit!==manifest.turnBudget.maxTurnsPerRun||ledger.total!==ledger.turns?.length
    ||!Array.isArray(ledger.reservations)||ledger.reservations.length!==0
    ||!Array.isArray(ledger.turns)||ledger.turns.some(x=>!['completed','not_dispatched'].includes(x.state)||x.childKind==='pending'))
    throw blocked('BLOCKED_RECOVERY','FULL is not demonstrably terminal and settled');
  for(const id of ['A','B','C']) {
    const row=await control(`case-${id.toLowerCase()}/case-state.json`);
    if(summary.cases?.[id]?.status!=='PASS'||row.caseId!==id||!settledNativeCase(row,ledger)
      ||row.integrity!=='PASS'||row.terminal?.result!=='PASS'||row.terminal.blocker!==null
      ||row.finalizer?.exitCode!==0)throw blocked('BLOCKED_RECOVERY','case finalization is not a known PASS');
  }
  const report=validateMeasurementReport(await api.exportMeasurement(runId),{qualify:true});
  if(report.run.id!==runId||report.run.mode!=='full'||report.run.status!=='PASS'
    ||report.run.profile!==manifest.productionProfile.id||report.benchmarkId!==manifest.benchmarkId
    ||report.benchmarkVersion!==manifest.benchmarkVersion||report.provenance.sourceFunctionalSha256!==source.sha256
    ||report.provenance.baseSha!==base.head||report.provenance.snapshotSha256!==snapshot.snapshotSha256
    ||report.cases.length!==3||['A','B','C'].some(id=>report.cases.find(x=>x.id===id)?.status!=='PASS'))
    throw blocked('BLOCKED_RECOVERY','export does not prove this measured FULL');
  let baseline=null;
  if(freeze.baselineRef?.sha256) {
    if(freeze.baselineRef.path!==BASELINE)throw blocked('BLOCKED_RECOVERY','baseline path differs');
    const bytes=await plain(path.join(root,BASELINE));
    if(digest(bytes)!==freeze.baselineRef.sha256)throw blocked('BLOCKED_RECOVERY','baseline bytes differ');
    baseline=validateMeasurementReport(JSON.parse(bytes));
  } else if(freeze.baselineRef?.status!=='unavailable')throw blocked('BLOCKED_RECOVERY','baseline proof missing');
  const comparison=baseline&&baseline.benchmarkVersion===manifest.benchmarkVersion&&baseline.run.profile===report.run.profile
    ?await api.compare(baseline,report):{directlyComparable:false,profileExperiment:false,
      mismatches:[baseline?'baseline version/profile differs':freeze.baselineRef.reason],deltas:'unavailable'};
  const outputs=[['run-01.json',report],['compare-01.json',comparison]].map(([name,value])=>
    ({file:path.join(dir,name),bytes:Buffer.from(JSON.stringify(value,null,2)+'\n')}));
  // Validate all partial outputs before creating any new one. Never replace a
  // divergent report, including on replay after a partially completed recovery.
  for(const output of outputs)if(await exists(output.file)&&!output.bytes.equals(await plain(output.file)))
    throw blocked('BLOCKED_RECOVERY','partial export or comparison differs');
  const binding={origin:'reconstructed-from-exclusive-terminal-run',campaignId,runId,
    controls:Object.fromEntries([...controls].map(([name,bytes])=>[name,digest(bytes)]))};
  if(replay&&(!isDeepStrictEqual(current.recovery?.binding,binding)
    ||current.recovery.originalStateSha256!==digest(Buffer.from(current.recovery.originalStateBytes))
    ||current.recovery.managerExit!==null||current.recovery.campaignExit!==null
    ||current.runId!==null||current.pendingCheckpoint!==null||current.runIndex!==2
    ||!isDeepStrictEqual(current.freeze,freeze)||current.completed?.length!==1
    ||current.completed[0].runId!==runId||current.completed[0].index!==1
    ||current.completed[0].reportSha256!==digest(outputs[0].bytes)
    ||current.completed[0].comparisonSha256!==digest(outputs[1].bytes)))
    throw blocked('BLOCKED_RECOVERY','recovery checkpoint differs');
  if(replay) {
    const {stateSha256:oldSeal,...oldBody}=state;
    const {stateSha256:currentSeal,...currentBody}=current;
    const expected={...oldBody,status:'RECOVERY_STOP',runIndex:2,completed:current.completed,recovery:current.recovery};
    if(!isDeepStrictEqual(currentBody,expected)||current.recovery.contract!=='terminal-full-recovery-v1'
      ||!Number.isFinite(Date.parse(current.recovery.recoveredAt)))
      throw blocked('BLOCKED_RECOVERY','recovery checkpoint immutable fields differ');
  }
  const controller=await api.recoveryVersion();
  if(!controller?.head||!/^sha256:[a-f0-9]{64}$/u.test(controller.sha256)
    ||replay&&!isDeepStrictEqual(current.recovery.controller,controller))throw blocked('BLOCKED_RECOVERY','recovery controller differs');
  await inactive();
  if((await api.gitState()).head!==base.head||(await api.identity()).sha256!==source.sha256
    ||!isDeepStrictEqual(report,await api.exportMeasurement(runId))
    ||!originalBytes.equals(await plain(stateFile)))throw blocked('BLOCKED_RECOVERY','evidence changed during recovery');
  for(const [name,bytes]of controls)if(!bytes.equals(await plain(path.join(runRoot,name))))
    throw blocked('BLOCKED_RECOVERY','terminal controls changed during recovery');
  if((await runIds(scratch)).size!==1)throw blocked('BLOCKED_RECOVERY','run origin changed during recovery');
  for(const output of outputs) {
    try {await fs.writeFile(output.file,output.bytes,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST'||!output.bytes.equals(await plain(output.file)))throw error;}
  }
  if(!replay)await updateCampaignState(stateFile,{...state,status:'RECOVERY_STOP',runIndex:2,
    completed:[{index:1,runId,reportSha256:digest(outputs[0].bytes),comparisonSha256:digest(outputs[1].bytes)}],
    recovery:{contract:'terminal-full-recovery-v1',controller,recoveredAt:new Date().toISOString(),
      originalStateBytes:originalBytes.toString(),originalStateSha256:digest(originalBytes),originalMarkerBytes:initialMarker,
      managerExit:null,campaignExit:null,binding}});
  // Keep the stale marker until the new checkpoint is durable. Only this exact
  // dead owner's marker can be removed; a changed/live owner remains a blocker.
  await inactive();
  if(await exists(marker)) {
    if((await plain(marker)).toString()!==initialMarker)throw blocked('BLOCKED_RECOVERY','controller marker changed after checkpoint');
    await fs.unlink(marker);
  }
  return {status:'RECOVERY_STOP',campaignId,runId,completedRuns:1,plannedRuns:freeze.plannedRuns,
    managerExit:null,campaignExit:null,recoveryController:controller};
  } finally {
    if(!activeBytes.equals(await plain(activeLock)))throw blocked('BLOCKED_ACTIVE','recovery lock changed; foreign lock preserved');
    await fs.unlink(activeLock);
  }
}

export async function runCampaign({ root = ROOT, hooks = {}, campaignId = null, runs = undefined,
  resumeId=null,maxOperations=undefined } = {}) {
  if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1)) throw blocked('BLOCKED_CONFIG', 'runs must be a positive integer');
  if(maxOperations!==undefined&&(!Number.isSafeInteger(maxOperations)||maxOperations<1))throw blocked('BLOCKED_CONFIG','invalid operation checkpoint limit');
  if(resumeId!==null&&(!/^campaign-[a-z0-9-]{8,}$/u.test(resumeId)||campaignId!==null&&campaignId!==resumeId))
    throw blocked('BLOCKED_CONFIG','invalid campaign resume identity');
  if (process.env.STNL_OFFLINE_PROVIDER_CONTEXT !== undefined) throw blocked('BLOCKED_BASE', 'TEST-ONLY provider cannot enter a formal campaign');
  const api = { ...adapters(root), ...hooks };
  const scratch = path.join(root, 'benchmark-temp');
  const signal = new AbortController();
  const onSignal = () => signal.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let lock = null; let campaignRoot = null; let index = 0; let runId = null;
  let state=null,ownsState=false;
  const say = (line) => console.log(line);
  const checkCancel = () => { if (signal.signal.aborted) throw blocked('CANCELLED', 'campaign interrupted'); };
  try {
    say('PRECHECK');
    const base = await api.gitState();
    const manifest = await readJson(path.join(root, 'benchmarks/sentinel-todo/benchmark.json'));
    const plannedRuns = runs ?? manifest.campaign?.fullRuns;
    if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1) throw blocked('BLOCKED_CONFIG', 'campaign.fullRuns must be a positive integer');
    let baseline = null;
    let baselineRef = { path: BASELINE, status: 'unavailable', reason: 'baseline absent' };
    try {
      const bytes = await fs.readFile(path.join(root, BASELINE));
      const candidate = validateMeasurementReport(JSON.parse(bytes));
      if (candidate.baselineVersion !== 1 || candidate.run.status !== 'PASS') throw new Error('invalid historical baseline');
      baseline = candidate;
      baselineRef = { path: BASELINE, runId: baseline.run.id, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    } catch (error) { baselineRef.reason = `baseline unavailable: ${error.code ?? error.message}`; }
    if ((await api.processes()).length) throw blocked('BLOCKED_ACTIVE', 'another benchmark process is alive');
    let recoveredCheckpoint=false;
    if(resumeId!==null&&(await readJson(path.join(scratch,resumeId,'state.json'))).status==='RECOVERY_STOP') {
      await recoverCompletedCampaign({root,campaignId:resumeId,hooks:api});
      recoveredCheckpoint=true;
    }
    await assertSafeScratch(scratch);
    checkCancel();
    say('LOCK');
    lock = await acquireCampaignLock(scratch, async () => {
      if (await exists(path.join(scratch, '.active-run.json')) || (await api.processes()).length) {
        throw blocked('BLOCKED_ACTIVE', 'benchmark became active before cleanup');
      }
    });
    checkCancel();
    say('VERIFY');
    const verified = await api.verify(signal.signal);
    checkCancel();
    if (verified.code !== 0) throw blocked('BLOCKED_VERIFY', `benchmark verify failed (${verified.code})`);
    const id = resumeId??campaignId ?? `campaign-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    if (!/^campaign-[a-z0-9-]{8,}$/u.test(id)) throw blocked('BLOCKED_DESTINATION', 'invalid campaign ID');
    const destination = path.join(root, MEASUREMENTS, id);
    if (await exists(destination)) throw blocked('BLOCKED_DESTINATION', `measurement destination already exists: ${destination}`);
    campaignRoot = path.join(scratch, id);
    const source = await api.identity();
    const reports = []; const comparisons = []; const files = {};
    const freeze={head:base.head,sourceFunctionalSha256:source.sha256,
      configurationSha256:digest(JSON.stringify(manifest)),plannedRuns,baselineRef};
    if(resumeId===null) {
      await fs.mkdir(campaignRoot);
      await fs.writeFile(path.join(campaignRoot,'.sentinel-campaign-owned'),CAMPAIGN_MARKER,{flag:'wx'});
      state={status:'ACTIVE',campaignId:id,freeze,startedAt:new Date().toISOString(),completed:[],runIndex:1,runId:null,pendingCheckpoint:null};
    } else {
      state=await readJson(path.join(campaignRoot,'state.json'));
      if(state.recovery&&!isDeepStrictEqual(state.recovery.controller,await api.recoveryVersion()))
        throw blocked('BLOCKED_RESUME','recovery controller version differs');
      const {stateSha256,...sealed}=state;
      if((state.status!=='FOCAL_STOP'&&!(recoveredCheckpoint&&state.status==='RECOVERY_STOP'))||state.campaignId!==id||!isDeepStrictEqual(state.freeze,freeze)
        ||stateSha256!==digest(JSON.stringify(sealed))||!Number.isFinite(Date.parse(state.startedAt))
        ||!Array.isArray(state.completed)||state.runIndex!==state.completed.length+1||state.runIndex>plannedRuns+(recoveredCheckpoint?1:0)
        ||(recoveredCheckpoint?(state.runId!==null||state.pendingCheckpoint!==null)
          :!/^run-[a-z0-9-]+$/u.test(state.runId??'')||!/^sha256:[a-f0-9]{64}$/u.test(state.pendingCheckpoint??'')))
        throw blocked('BLOCKED_RESUME','campaign has no matching safe FULL checkpoint');
      for(const [offset,accepted]of state.completed.entries()) {
        const n=offset+1,name=`run-${String(n).padStart(2,'0')}.json`,comparisonName=`compare-${String(n).padStart(2,'0')}.json`;
        if(accepted.index!==n||!/^run-[a-z0-9-]+$/u.test(accepted.runId??'')
          ||state.completed.some((other,i)=>i!==offset&&other.runId===accepted.runId)||accepted.runId===state.runId)
          throw blocked('BLOCKED_RESUME','campaign completed run identity differs');
        const bytes=await fs.readFile(path.join(campaignRoot,name)),comparisonBytes=await fs.readFile(path.join(campaignRoot,comparisonName));
        const report=validateMeasurementReport(JSON.parse(bytes),{qualify:true});
        if(digest(bytes)!==accepted.reportSha256||digest(comparisonBytes)!==accepted.comparisonSha256
          ||report.run.id!==accepted.runId||report.run.status!=='PASS'||report.run.mode!=='full'
          ||report.provenance.sourceFunctionalSha256!==source.sha256
          ||!isDeepStrictEqual(report,await api.exportMeasurement(accepted.runId)))
          throw blocked('BLOCKED_RESUME','campaign accepted report or evidence differs');
        reports.push(report);comparisons.push(JSON.parse(comparisonBytes));files[name]=path.join(campaignRoot,name);
      }
      if(!recoveredCheckpoint) {
      const pending=await readJson(path.join(scratch,state.runId,'run.json'));
      if(pending.runId!==state.runId||pending.mode!=='full'||pending.status!=='FOCAL_STOP'
        ||pending.snapshot?.sourceFunctionalSha256!==source.sha256||pending.resumeCheckpoint!==state.pendingCheckpoint)
        throw blocked('BLOCKED_RESUME','pending FULL identity/checkpoint differs');
      await api.preflightFullResume(state.runId);
      }
    }
    const startedAt=state.startedAt;
    ownsState=true;await updateCampaignState(path.join(campaignRoot,'state.json'),{...state,status:'ACTIVE'});
    const resumeIndex=resumeId===null||recoveredCheckpoint?null:state.runIndex;
    for (index = state.completed.length+1; index <= plannedRuns; index += 1) {
      checkCancel();
      if ((await api.gitState()).head !== base.head || (await api.identity()).sha256 !== source.sha256) {
        throw blocked('CAMPAIGN_SOURCE_DRIFT', `checkout or functional source changed before run ${index}`);
      }
      say(`RUN ${index}/${plannedRuns}`);
      const before = await runIds(scratch);
      const resuming=index===resumeIndex;
      runId=resuming?state.runId:null;
      state={...state,status:'ACTIVE',runIndex:index,runId};
      await updateCampaignState(path.join(campaignRoot,'state.json'),state);
      const result = resuming?await api.resumeFull(runId,signal.signal,{maxOperations}):await api.runFull(signal.signal,{maxOperations});
      const created = [...await runIds(scratch)].filter((item) => !before.has(item));
      if (created.length !== (resuming?0:1)) throw blocked('BLOCKED_RUN_ID', `run ${index} created ${created.length} run directories`);
      if(!resuming)runId = created[0];
      const runRoot = path.join(scratch, runId);
      const run = await readJson(path.join(runRoot, 'run.json'));
      const summary = await readJson(path.join(runRoot, 'summary.json')).catch(() => null);
      checkCancel();
      if(result.code===0&&run.runId===runId&&run.mode==='full'&&run.status==='FOCAL_STOP'
        &&summary?.runId===runId&&summary.mode==='full'&&summary.status==='FOCAL_STOP'
        &&run.snapshot?.sourceFunctionalSha256===source.sha256&&/^sha256:[a-f0-9]{64}$/u.test(run.resumeCheckpoint??'')
        &&['A','B','C'].every(key=>['PASS','FOCAL_STOP','NOT_RUN'].includes(summary.cases?.[key]?.status))) {
        await api.preflightFullResume(runId);
        state={...state,status:'FOCAL_STOP',runId,pendingCheckpoint:run.resumeCheckpoint};
        await updateCampaignState(path.join(campaignRoot,'state.json'),state);
        return {status:'FOCAL_STOP',campaignId:id,plannedRuns,completedRuns:reports.length,runId};
      }
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
      const report = validateMeasurementReport(await readJson(file), { qualify: true });
      if (report.benchmarkId !== manifest.benchmarkId || report.benchmarkVersion !== manifest.benchmarkVersion
        || report.run.id !== runId || report.run.status !== 'PASS' || report.run.mode !== 'full' || report.run.profile !== manifest.productionProfile.id
        || report.provenance.sourceFunctionalSha256 !== source.sha256
        || report.cases.length !== 3 || ['A', 'B', 'C'].some((key) => report.cases.find((row) => row.id === key)?.status !== 'PASS')) {
        throw blocked('BLOCKED_REPORT', `run ${index} ${runId}: invalid campaign report`);
      }
      say(`COMPARE ${index}/${plannedRuns}`);
      const comparison = baseline && baseline.benchmarkVersion === manifest.benchmarkVersion && baseline.run.profile === report.run.profile
        ? await api.compare(baseline, report)
        : { directlyComparable: false, profileExperiment: false, mismatches: [baseline ? 'baseline version/profile differs' : baselineRef.reason], deltas: 'unavailable' };
      await writeJson(path.join(campaignRoot, `compare-${String(index).padStart(2, '0')}.json`), comparison);
      reports.push(report); comparisons.push(comparison); files[name] = file;
      state={...state,completed:[...state.completed,{index,runId,reportSha256:digest(await fs.readFile(file)),
        comparisonSha256:digest(await fs.readFile(path.join(campaignRoot,`compare-${String(index).padStart(2,'0')}.json`)))}],
        runId:null,pendingCheckpoint:null};
      await updateCampaignState(path.join(campaignRoot,'state.json'),state);
      runId = null;
    }
    if ((await api.gitState()).head !== base.head || (await api.identity()).sha256 !== source.sha256) {
      throw blocked('CAMPAIGN_SOURCE_DRIFT', 'checkout or functional source changed before promotion');
    }
    index = plannedRuns;
    checkCancel();
    say('SUMMARY');
    const campaign = campaignSummary({ campaignId: id, head: base.head, startedAt, endedAt: new Date().toISOString(),
      baselineRef, reports, comparisons, plannedRuns,recovery:state.recovery??null });
    files['campaign-summary.json'] = path.join(campaignRoot, 'campaign-summary.json');
    await writeJson(files['campaign-summary.json'], campaign);
    checkCancel();
    say('PROMOTE');
    const promoted = await promote(root, id, files, signal.signal);
    await updateCampaignState(path.join(campaignRoot, 'state.json'),
      {...state,status: 'CAMPAIGN_COMPLETE', campaignId: id, endedAt: campaign.endedAt }).catch((error) => {
      console.error(`scratch status could not be written: ${error.message}`);
    });
    say(`CAMPAIGN_COMPLETE ${id}: ${plannedRuns}/${plannedRuns} PASS`);
    say(`reports: ${path.relative(root, promoted)}`);
    say(`raws: ${path.relative(root, scratch)}`);
    say('next: review and commit the reports; do not rerun this campaign');
    return campaign;
  } catch (error) {
    const status = signal.signal.aborted ? 'CANCELLED' : error.code ?? 'BLOCKED';
    if (campaignRoot&&ownsState) await updateCampaignState(path.join(campaignRoot, 'state.json'),
      {...state,status: status === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', blockerCode: status,
        runIndex: index, runId, blocker: error.message, endedAt: new Date().toISOString() }).catch(() => {});
    else if (lock&&resumeId===null) await writeJson(path.join(scratch, '.campaign-state.json'),
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

// Functional and formal entrypoints share N, but only the latter requires a
// clean Git candidate and comparison gate. Neither entrypoint cleans history.
export async function runFunctionalBenchmark({ root = ROOT, hooks = {}, runs = undefined } = {}) {
  if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1)) throw blocked('BLOCKED_CONFIG', 'runs must be a positive integer');
  if (process.env.STNL_OFFLINE_PROVIDER_CONTEXT !== undefined) throw blocked('BLOCKED_BASE', 'TEST-ONLY provider cannot enter a functional campaign');
  const manifest = await readJson(path.join(root, 'benchmarks/sentinel-todo/benchmark.json'));
  const requiredFunctionalRuns = manifest.campaign?.fullRuns;
  if (!Number.isSafeInteger(requiredFunctionalRuns) || requiredFunctionalRuns < 1) throw blocked('BLOCKED_CONFIG', 'campaign.fullRuns must be a positive integer');
  const plannedRuns = runs ?? requiredFunctionalRuns;
  if (!Number.isSafeInteger(plannedRuns) || plannedRuns < 1) throw blocked('BLOCKED_CONFIG', 'campaign.fullRuns must be a positive integer');
  if (plannedRuns > MAX_FUNCTIONAL_RUNS || requiredFunctionalRuns > MAX_FUNCTIONAL_RUNS)
    throw blocked('BLOCKED_CONFIG', `functional campaign is limited to ${MAX_FUNCTIONAL_RUNS} FULLs`);
  const api = { ...adapters(root), ...hooks };
  const scratch = path.join(root, 'benchmark-temp');
  const signal = new AbortController();
  const onSignal = () => signal.abort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let lock = null; let campaignRoot = null; let completed = 0;
  const reports = []; const comparisons = []; const startedAt = new Date().toISOString();
  const files = {};
  const say = (line) => console.log(line);
  const checkCancel = () => { if (signal.signal.aborted) throw blocked('CANCELLED', 'benchmark interrupted'); };
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
      if (entry.name === '.retained') {
        if (await fs.readFile(path.join(item, '.sentinel-retention-owned'), 'utf8').catch(() => null) !== 'sentinel-local-retention-v1\n')
          throw blocked('BLOCKED_CLEANUP', `unowned retained evidence: ${item}`);
        for (const archived of await fs.readdir(item, { withFileTypes: true })) {
          if (archived.name === '.sentinel-retention-owned') continue;
          if (!archived.isDirectory() || !/^run-[a-z0-9-]+$/u.test(archived.name)
            || await fs.readFile(path.join(item, archived.name, '.sentinel-benchmark-owned'), 'utf8').catch(() => null) !== RUN_MARKER)
            throw blocked('BLOCKED_CLEANUP', `unknown retained evidence: ${archived.name}`);
        }
        continue;
      }
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
        const ledger = await readJson(path.join(item, '.turn-ledger.json')).catch(() => null);
        for (const child of await fs.readdir(item, { withFileTypes: true })) {
          if (!child.isDirectory() || !/^case-[a-c]$/u.test(child.name)) continue;
          const caseRoot = path.join(item, child.name);
          const state = await readJson(path.join(caseRoot, 'case-state.json')).catch(() => null);
          if (!state || state.caseId !== child.name.slice(5).toUpperCase() || !run.cases.includes(state.caseId)
            || !TERMINAL.has(state.status) || summary.cases?.[state.caseId]?.status !== state.status
            || (state.protocol === 'native-app-server-v1'
              ? !settledNativeCleanupCase(state, ledger, run.runId)
              : state.privateHomeRemoved !== true && !(state.privateHomeSuspended === true && state.suspendedHome)
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
    // Terminal history already has its raw/state evidence. No deletion or
    // re-publication of another invocation is required to start this one.
    // Full retain-before-clean settlement remains owned by explicit clean.
    checkCancel();
    if ((await api.processes()).length || await exists(path.join(scratch, '.active-run.json')))
      throw blocked('BLOCKED_ACTIVE', 'benchmark activity detected before full run');
    const campaignId = `campaign-functional-${randomUUID()}`;
    campaignRoot = path.join(scratch, campaignId);
    await fs.mkdir(campaignRoot);
    await fs.writeFile(path.join(campaignRoot, '.sentinel-campaign-owned'), CAMPAIGN_MARKER, { flag: 'wx' });
    await writeJson(path.join(campaignRoot, 'state.json'), { campaignId, status: 'ACTIVE', plannedRuns, startedAt });
    for (let index = 1; index <= plannedRuns; index += 1) {
      checkCancel();
      if ((await api.processes()).length || await exists(path.join(scratch, '.active-run.json')))
        throw blocked('BLOCKED_ACTIVE', 'benchmark activity detected before full run');
      say(`RUN FULL ${index}/${plannedRuns}`);
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
        if (run?.runId !== runId || run.mode !== 'full' || summary?.runId !== runId || summary.mode !== 'full'
          || run.status !== summary.status || run.status !== report.run.status)
          throw blocked('BLOCKED_REPORT', 'functional run/summary/report identity or outcome differs');
        // This entrypoint records functional acceptance independently from
        // measurement completeness. Product/oracle and ABC qualification stay
        // mandatory; incomplete metrics are retained as diagnostic evidence.
        validateMeasurementReport(report, { qualify: true, requireCompleteMeasurement: false });
        if (report.benchmarkId !== manifest.benchmarkId || report.benchmarkVersion !== manifest.benchmarkVersion
          || report.run.profile !== manifest.productionProfile.id
          || (reports.length && report.provenance.sourceFunctionalSha256 !== reports[0].provenance.sourceFunctionalSha256))
          throw blocked('BLOCKED_REPORT', 'functional report candidate identity differs');
        const name = `run-${String(index).padStart(2, '0')}.json`;
        files[name] = path.join(campaignRoot, name);
        await writeJson(files[name], report);
        reports.push(report);
      } catch (error) {
        console.error(`diagnostic report for ${runId} could not be staged; raw evidence retained: ${error.message}`);
        const failure = blocked(status === 'PASS' ? 'BLOCKED_REPORT' : status, `run ${runId} outcome ${status}; cases ${JSON.stringify(summary?.cases ?? null)}; manager exit ${result.code}; diagnostic export/staging failed: ${error.message}; raw evidence retained at ${runRoot}`);
        failure.exitCode = result.code || 1;
        throw failure;
      }
      if (result.code !== 0 || status !== 'PASS' || reports.at(-1).run.status !== status
        || ['A', 'B', 'C'].some(id => summary?.cases?.[id]?.status !== 'PASS')) {
        const failure = blocked(status === 'PASS' ? 'BLOCKED_RUN' : status, `run ${runId} outcome ${status}; cases ${JSON.stringify(summary?.cases ?? null)}; manager exit ${result.code}; raw evidence ${runRoot}`);
        failure.exitCode = result.code || 1;
        throw failure;
      }
      completed = index;
      comparisons.push({ directlyComparable: false, profileExperiment: false, deltas: 'unavailable', mismatches: ['functional campaign has no comparison baseline'] });
    }
    checkCancel();
    const last = reports.at(-1);
    const summary = campaignSummary({ campaignId, head: 'unavailable', startedAt, endedAt: new Date().toISOString(),
      baselineRef: { status: 'unavailable', reason: 'functional campaign has no comparison baseline' }, reports, comparisons, plannedRuns });
    const measurementStates = reports.map(report => measurementCompleteness(report));
    const measurementComplete = measurementStates.every(state => state.status === 'complete');
    const functionalRepetitionComplete = plannedRuns >= requiredFunctionalRuns;
    summary.status = functionalRepetitionComplete ? 'FUNCTIONAL_ACCEPTED' : 'FUNCTIONAL_ROUNDS_PARTIAL';
    summary.acceptance = { functional: functionalRepetitionComplete ? 'PASS' : 'PENDING', functionalRuns: {
      required: requiredFunctionalRuns, completed: completed,
    }, measurement: {
      status: measurementComplete ? 'complete' : 'incomplete',
      missing: [...new Set(measurementStates.flatMap(state => state.missing))],
    } };
    summary.runs.forEach((row, index) => { row.measurementStatus = measurementStates[index].status; });
    if (!functionalRepetitionComplete) {
      // A single passing FULL is only a completed round. Keep per-run evidence,
      // but do not present run subsets as qualified campaign distributions.
      summary.distribution.g2 = Object.fromEntries(Object.keys(summary.distribution.g2).map(key => [key, 'unavailable']));
      summary.distribution.g3 = Object.fromEntries(Object.keys(summary.distribution.g3).map(key => [key, 'unavailable']));
    } else if (!measurementComplete) {
      // Per-run reports retain observed partial values. Do not summarize them
      // as G3 campaign distributions when expected observations are absent.
      summary.distribution.g3 = Object.fromEntries(Object.keys(summary.distribution.g3).map(key => [key, 'unavailable']));
    }
    files['campaign-summary.json'] = path.join(campaignRoot, 'campaign-summary.json');
    await writeJson(files['campaign-summary.json'], summary);
    if (!functionalRepetitionComplete) {
      checkCancel();
      await fs.writeFile(path.join(campaignRoot, 'state.json'), `${JSON.stringify({ campaignId,
        status: 'FUNCTIONAL_ROUNDS_PARTIAL', plannedRuns, completedRuns: completed, requiredFunctionalRuns,
        endedAt: summary.endedAt, measurementStatus: measurementComplete ? 'complete' : 'incomplete' })}\n`).catch(error=>console.error(`functional round evidence retained; scratch state update failed: ${error.message}`));
      say(`FUNCTIONAL_ROUND_PASS ${campaignId}: ${completed}/${requiredFunctionalRuns} rounds; acceptance pending; evidence retained in ${campaignRoot}`);
      return { runId: last.run.id, status: 'FUNCTIONAL_ROUND_PASS', plannedRuns, completedRuns: completed,
        requiredFunctionalRuns, functionalAcceptance: 'PENDING', runs: reports.map(row => row.run.id),
        measurements: null, evidence: campaignRoot, measurement: summary.acceptance.measurement };
    }
    if (!measurementComplete) {
      checkCancel();
      await fs.writeFile(path.join(campaignRoot, 'state.json'), `${JSON.stringify({ campaignId,
        status: 'FUNCTIONAL_ACCEPTED', plannedRuns, completedRuns: completed, requiredFunctionalRuns, endedAt: summary.endedAt,
        measurementStatus: 'incomplete' })}\n`).catch(error=>console.error(`functional evidence retained; scratch state update failed: ${error.message}`));
      say(`FUNCTIONAL_PASS ${campaignId}: ${completed}/${plannedRuns}; measurement incomplete; evidence retained in ${campaignRoot}`);
      return { runId: last.run.id, status: 'FUNCTIONAL_PASS', plannedRuns, completedRuns: completed,
        requiredFunctionalRuns, functionalAcceptance: 'PASS', runs: reports.map(row => row.run.id), measurements: null, evidence: campaignRoot,
        measurement: summary.acceptance.measurement };
    }
    // Reuse the formal entrypoint's atomic promotion only after the same N/N
    // summary qualification. Partial reports remain in ignored campaign scratch.
    checkCancel();
    const promoted = await promote(root, campaignId, files, signal.signal);
    await fs.writeFile(path.join(campaignRoot, 'state.json'), `${JSON.stringify({ campaignId,
      status: 'CAMPAIGN_COMPLETE', plannedRuns, completedRuns: completed, endedAt: summary.endedAt })}\n`).catch(error=>console.error(`qualified campaign promoted; scratch state update failed: ${error.message}`));
    say(`PASS ${campaignId}: ${completed}/${plannedRuns}; reports published`);
    return { runId: last.run.id, status: 'PASS', plannedRuns, completedRuns: completed, requiredFunctionalRuns,
      functionalAcceptance: 'PASS', runs: reports.map(row => row.run.id), measurements: promoted };
  } catch (error) {
    if (campaignRoot) await fs.writeFile(path.join(campaignRoot, 'state.json'), `${JSON.stringify({
      status: signal.signal.aborted ? 'CANCELLED' : 'BLOCKED', plannedRuns, completedRuns: completed,
      blocker: error.message, endedAt: new Date().toISOString() })}\n`).catch(() => {});
    console.error(`${error.code ?? 'BLOCKED'}: ${error.message}`);
    throw error;
  } finally {
    if (lock) await fs.unlink(lock).catch(() => {});
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

export function parseCampaignArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { mode: 'help' };
  const functional = argv[0] === '--functional';
  const rest = functional ? argv.slice(1) : argv;
  const options={mode:functional?'functional':'campaign'},seen=new Set();
  const usage='usage: benchmark-campaign.mjs [--functional] [--runs N] [--resume campaign-id] [--max-operations N] | --recover-completed campaign-id --root measured-checkout | --help';
  for(let i=0;i<rest.length;i+=2) {
    const flag=rest[i],value=rest[i+1];
    if(seen.has(flag)||typeof value!=='string')throw blocked('BLOCKED_CONFIG',usage);seen.add(flag);
    if(flag==='--runs'||flag==='--max-operations'&&!functional) {
      const n=Number(value);
      if(!/^[0-9]+$/u.test(value)||!Number.isSafeInteger(n)||n<1)throw blocked('BLOCKED_CONFIG',usage);
      if(functional&&flag==='--runs'&&n>MAX_FUNCTIONAL_RUNS)throw blocked('BLOCKED_CONFIG',usage);
      options[flag==='--runs'?'runs':'maxOperations']=n;
    } else if(flag==='--recover-completed'&&!functional&&/^campaign-[a-z0-9-]{8,}$/u.test(value)) {options.mode='recover';options.campaignId=value;}
    else if(flag==='--root'&&!functional&&path.isAbsolute(value))options.root=value;
    else if(flag==='--resume'&&!functional&&/^campaign-[a-z0-9-]{8,}$/u.test(value))options.resumeId=value;
    else throw blocked('BLOCKED_CONFIG',usage);
  }
  if(options.mode==='recover'&&(!options.root||options.resumeId||options.runs||options.maxOperations)
    ||options.mode!=='recover'&&options.root&&!options.resumeId)throw blocked('BLOCKED_CONFIG',usage);
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseCampaignArgs(process.argv.slice(2));
    if (options.mode === 'help') {
      const config = await readJson(path.join(ROOT, 'benchmarks/sentinel-todo/benchmark.json'));
      console.log(`Functional ${config.campaign.fullRuns}-full campaign: npm run benchmark\nFormal ${config.campaign.fullRuns}-full campaign: npm run benchmark:campaign\nOverride: npm run benchmark[:campaign] -- --runs N`);
    } else if(options.mode==='recover')console.log(JSON.stringify(await recoverCompletedCampaign(options)));
    else if (options.mode === 'functional') await runFunctionalBenchmark({ runs: options.runs });
    else await runCampaign({ root:options.root,runs: options.runs,resumeId:options.resumeId,maxOperations:options.maxOperations });
  } catch (error) { console.error(`${error.code ?? 'BLOCKED'}: ${error.message}`); process.exitCode = error.exitCode ?? 1; }
}
