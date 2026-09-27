#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSnapshotIntegrity } from './benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UNAVAILABLE = 'unavailable';
const SOURCE_ROOTS = ['skills', 'agents', 'templates', 'scripts', 'benchmarks/sentinel-todo'];
const json = (p) => fs.readFile(p, 'utf8').then(JSON.parse);

async function frozenSourceIdentity(snapshotRoot) {
  const files = [];
  async function visit(relative) {
    for (const entry of (await fs.readdir(path.join(snapshotRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._') || entry.name === 'node_modules') continue;
      const child = path.join(relative, entry.name);
      const stat = await fs.lstat(path.join(snapshotRoot, child));
      if (stat.isSymbolicLink()) throw new Error(`snapshot source contains a symlink: ${child}`);
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) files.push(child);
    }
  }
  for (const root of SOURCE_ROOTS) await visit(root);
  const hash = createHash('sha256').update('sentinel-functional-snapshot-v1\0');
  for (const relative of files.sort()) {
    const bytes = await fs.readFile(path.join(snapshotRoot, relative));
    hash.update(relative.split(path.sep).join('/')).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return { sha256: `sha256:${hash.digest('hex')}`, fileCount: files.length };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`invalid argument: ${rest[i]}`);
    args[rest[i].slice(2)] = rest[++i];
  }
  return { command, args };
}

function required(args, key) {
  if (!args[key]) throw new Error(`--${key} is required`);
  return args[key];
}

async function optionalJson(file) {
  try { return await json(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function numeric(v) { return Number.isFinite(v) ? v : null; }

function observationsFrom(evidence) {
  const all = [];
  if (evidence.turn?.usageObservation) all.push(evidence.turn.usageObservation);
  if (evidence.usageObservation) all.push(evidence.usageObservation);
  all.push(...(evidence.runner?.usageObservations ?? []));
  return all;
}

async function measurement(runId) {
  if (!/^[a-z0-9][a-z0-9-]{7,}$/u.test(runId)) throw new Error('invalid run id');
  const runRoot = path.join(ROOT, 'benchmark-temp', runId);
  const run = await json(path.join(runRoot, 'run.json'));
  if (run.runId !== runId || run.mode !== 'full' || !['PASS', 'FAIL', 'ABORTED'].includes(run.status)) {
    throw new Error('run must be a terminal full run with matching identity');
  }
  const snapshot = await assertSnapshotIntegrity(runRoot, { checkSource: false });
  if (run.snapshot?.snapshotSha256 !== snapshot.snapshotSha256 || run.snapshot?.sourceFunctionalSha256 !== snapshot.sourceFunctionalSha256) {
    throw new Error('run and frozen snapshot identities differ');
  }
  const frozenIdentity = await frozenSourceIdentity(path.join(runRoot, 'snapshot'));
  if (frozenIdentity.sha256 !== snapshot.sourceFunctionalSha256 || frozenIdentity.fileCount !== snapshot.sourceFileCount) {
    throw new Error('frozen source content does not match its recorded functional identity');
  }
  const config = await json(path.join(runRoot, 'snapshot/benchmarks/sentinel-todo/benchmark.json'));
  const cases = [];
  const summary = await json(path.join(runRoot, 'summary.json'));
  if (summary.runId !== runId || summary.status !== run.status || summary.mode !== run.mode) throw new Error('run summary identity differs from run.json');
  for (const id of run.cases) {
    const dir = path.join(runRoot, `case-${id.toLowerCase()}`);
    const [raw, state, journal] = await Promise.all([
      optionalJson(path.join(dir, 'raw.json')), optionalJson(path.join(dir, 'case-state.json')),
      optionalJson(path.join(dir, 'journal.json')),
    ]);
    if (!raw || !state || !journal || state.status === 'ACTIVE' || !state.endedAt || state.status !== raw.status) throw new Error(`case ${id} is incomplete or case state differs from result`);
    const events = journal.events ?? [];
    const summaryCase = summary.cases?.[id];
    if (!summaryCase || summaryCase.status !== raw.status || summaryCase.operations !== events.length
      || (Number.isInteger(raw.operations?.total) && raw.operations.total !== events.length)
      || (state.terminal?.result && state.terminal.result !== raw.status)
      || summaryCase.mainTurns !== state.mainTurns || summaryCase.runnerTurns !== state.runnerTurns) {
      throw new Error(`case ${id} summary differs from raw state or operation journal`);
    }
    const counts = Object.fromEntries(['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'REPLAN', 'SPEC_RESUME', 'REVIEW_PLAN', 'REVIEW_TASKS'].map((k) => [k, events.filter((e) => e.operation === k).length]));
    const runnerBearingOperations = events.filter((e) => (e.childDispatches ?? []).some((d) => d.role === 'stnl_validation_runner')).length;
    const bySlice = {};
    for (const e of events) if (e.slice) {
      const row = bySlice[e.slice] ??= { execute: 0, validate: 0, applyFindings: 0 };
      if (e.operation === 'EXECUTE_SLICE') row.execute += 1;
      if (e.operation === 'VALIDATE_SLICE') row.validate += 1;
      if (e.operation === 'APPLY_FINDINGS') row.applyFindings += 1;
    }
    const evidenceFiles = await Promise.all((state.operations ?? []).map((op) => optionalJson(path.join(dir, path.basename(op.evidencePath ?? '')))));
    const observations = evidenceFiles.filter(Boolean).flatMap(observationsFrom);
    const seen = new Set();
    const unique = observations.filter((o) => {
      const key = o.eventId ?? `${o.source}:${o.threadId}:${JSON.stringify(o.delta)}`;
      if (seen.has(key)) return false;
      seen.add(key); return o.status === 'attributable' && o.delta;
    });
    const main = unique.filter((o) => o.source === 'main');
    const runner = unique.filter((o) => o.source === 'runner');
    const sum = (rows, field) => rows.length && rows.every((o) => numeric(o.delta[field]) !== null)
      ? rows.reduce((n, o) => n + o.delta[field], 0) : UNAVAILABLE;
    const inputValues = (rows) => rows.length && rows.every((o) => numeric(o.delta.input) !== null) ? rows.map((o) => o.delta.input) : null;
    const tokenStats = (rows) => {
      if (!rows.length) return UNAVAILABLE;
      const inputs = inputValues(rows); const input = sum(rows, 'input');
      return { turns: rows.length, input, output: sum(rows, 'output'), cachedInput: sum(rows, 'cachedInput'), reasoningOutput: sum(rows, 'reasoningOutput'),
        peakInputPerTurn: inputs ? Math.max(...inputs) : UNAVAILABLE, medianInputPerTurn: inputs ? median(inputs) : UNAVAILABLE,
        meanInputPerTurn: inputs ? input / rows.length : UNAVAILABLE, inputByTurn: inputs ?? [] };
    };
    cases.push({
      id, status: raw.status, operations: events.length, mainTurns: state.mainTurns ?? UNAVAILABLE,
      runnerTurns: state.runnerTurns ?? UNAVAILABLE, execution: raw.finalExecutionState ?? UNAVAILABLE,
      specClosed: raw.specClosed ?? UNAVAILABLE, finalizer: state.finalizer?.exitCode === 0 ? 'PASS' : 'FAIL',
      finalTestsPassed: raw.finalTestsPassed ?? UNAVAILABLE,
      profileMismatches: raw.modelUse?.profileMismatches ?? UNAVAILABLE,
      provider: state.isolation?.provider ?? UNAVAILABLE,
      authMode: state.isolation?.authMode ?? UNAVAILABLE,
      isolation: state.isolation?.filesystemSandbox ?? UNAVAILABLE,
      findingsCycles: raw.operations?.findingsCycles ?? UNAVAILABLE, recoveryOperations: counts.APPLY_FINDINGS + counts.REPLAN + counts.SPEC_RESUME,
      extraRunnerTurns: Math.max(0, (numeric(state.runnerTurns) ?? 0) - runnerBearingOperations),
      repeatedReviewRounds: Math.max(0, counts.REVIEW_PLAN - 1) + Math.max(0, counts.REVIEW_TASKS - 1),
      durationMs: state.startedAt && state.endedAt ? Date.parse(state.endedAt) - Date.parse(state.startedAt) : UNAVAILABLE,
      slices: raw.decomposition?.slices ?? UNAVAILABLE, operationCounts: counts, operationsBySlice: bySlice,
      operationDurations: events.map((event) => ({ operation: event.operation, slice: event.slice ?? null,
        durationMs: numeric(event.durationMs) ?? UNAVAILABLE })),
      repeatedAttemptsBySlice: Object.fromEntries(Object.entries(bySlice).map(([slice, v]) => [slice,
        { execute: Math.max(0, v.execute - 1), validate: Math.max(0, v.validate - 1) }])),
      telemetry: { coverage: { main: `${main.length}/${state.mainTurns ?? UNAVAILABLE}`, runner: `${runner.length}/${state.runnerTurns ?? UNAVAILABLE}` }, main: tokenStats(main), runner: tokenStats(runner) },
    });
  }
  const caseById = Object.fromEntries(config.cases.map((c) => [c.id, c]));
  const resultSchemaHash = `sha256:${createHash('sha256').update(await fs.readFile(path.join(runRoot, 'snapshot/benchmarks/sentinel-todo', config.schemas.result))).digest('hex')}`;
  return {
    schemaVersion: 1, benchmarkId: config.benchmarkId, benchmarkVersion: config.benchmarkVersion,
    resultDefinition: 'full run is PASS when manager status is PASS and all included cases have passing finalizers',
    run: { id: runId, status: run.status, mode: run.mode, profile: run.profile ?? UNAVAILABLE, startedAt: run.startedAt, endedAt: run.endedAt ?? UNAVAILABLE },
    provenance: { baseSha: snapshot.baseSha, dirty: snapshot.dirty, functionalDiffSha256: snapshot.functionalDiffSha256,
      sourceFunctionalSha256: snapshot.sourceFunctionalSha256, snapshotSha256: snapshot.snapshotSha256, snapshotCreatedAt: snapshot.createdAt },
    comparability: { schemaVersion: 1, benchmarkVersion: config.benchmarkVersion, profile: run.profile ?? UNAVAILABLE,
      requirementsHashes: Object.fromEntries(run.cases.map((id) => [id, caseById[id]?.requirementsHash ?? UNAVAILABLE])),
      fixtureContentHashes: Object.fromEntries(run.cases.map((id) => [id, caseById[id]?.fixtureContentHash ?? UNAVAILABLE])),
      seedHash: config.integrity?.seedContentHash ?? UNAVAILABLE,
      resultSchemaVersion: config.schemaVersions.result, resultSchemaHash,
      metricDefinitions: 'g2-operation-counts-v1;g3-attributable-usage-delta-v1',
      qualification: { harnessContractVersion: config.productionPilot?.qualification?.harnessContractVersion ?? UNAVAILABLE,
        providerVersion: config.productionPilot?.qualification?.providerVersion ?? UNAVAILABLE,
        capabilitiesHash: config.productionPilot?.qualification?.capabilitiesHash ?? UNAVAILABLE,
        sandboxProbeStatus: config.productionPilot?.qualification?.sandboxProbeStatus ?? UNAVAILABLE,
        sandboxProbeEvidenceSha256: config.productionPilot?.qualification?.sandboxProbeEvidenceSha256 ?? UNAVAILABLE }, resultDefinition: 'full-pass-v1' },
    cases,
    aggregate: { operations: cases.reduce((n, c) => n + c.operations, 0), mainTurns: cases.reduce((n, c) => n + (numeric(c.mainTurns) ?? 0), 0),
      runnerTurns: cases.reduce((n, c) => n + (numeric(c.runnerTurns) ?? 0), 0), recoveryOperations: cases.reduce((n, c) => n + c.recoveryOperations, 0),
      happyPathOperations: cases.reduce((n, c) => n + c.operations - c.recoveryOperations, 0),
      extraRunnerTurns: cases.reduce((n, c) => n + c.extraRunnerTurns, 0), repeatedReviewRounds: cases.reduce((n, c) => n + c.repeatedReviewRounds, 0),
      repeatedExecuteAttempts: cases.reduce((n, c) => n + Object.values(c.repeatedAttemptsBySlice).reduce((x, v) => x + v.execute, 0), 0),
      repeatedValidateAttempts: cases.reduce((n, c) => n + Object.values(c.repeatedAttemptsBySlice).reduce((x, v) => x + v.validate, 0), 0),
      wallDurationMs: run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : UNAVAILABLE,
      summedCaseDurationMs: cases.every((c) => numeric(c.durationMs) !== null) ? cases.reduce((n, c) => n + c.durationMs, 0) : UNAVAILABLE,
      telemetry: aggregateTelemetry(cases) },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateTelemetry(cases) {
  const collect = (key) => cases.flatMap((c) => c.telemetry[key] === UNAVAILABLE ? [] : [c.telemetry[key]]);
  const main = collect('main'); const runner = collect('runner');
  const agg = (groups) => {
    if (!groups.length) return UNAVAILABLE;
    const sumFields = (key) => groups.every((x) => Number.isFinite(x[key])) ? groups.reduce((n, x) => n + x[key], 0) : UNAVAILABLE;
    const inputValues = groups.every((x) => Array.isArray(x.inputByTurn) && x.inputByTurn.length === x.turns) ? groups.flatMap((x) => x.inputByTurn) : null;
    const input = sumFields('input'); const turns = groups.reduce((n, x) => n + x.turns, 0);
    return { turns, input, output: sumFields('output'), cachedInput: sumFields('cachedInput'), reasoningOutput: sumFields('reasoningOutput'),
      peakInputPerTurn: inputValues ? Math.max(...inputValues) : UNAVAILABLE,
      medianInputPerTurn: inputValues ? median(inputValues) : UNAVAILABLE,
      meanInputPerTurn: inputValues ? input / turns : UNAVAILABLE };
  };
  const turns = [...main, ...runner];
  return { coverage: { main: `${main.reduce((n, x) => n + x.turns, 0)}/${cases.reduce((n, c) => n + (numeric(c.mainTurns) ?? 0), 0)}`,
      runner: `${runner.reduce((n, x) => n + x.turns, 0)}/${cases.reduce((n, c) => n + (numeric(c.runnerTurns) ?? 0), 0)}` }, main: agg(main), runner: agg(runner),
    peakInputPerTurn: turns.length && turns.every((x) => numeric(x.peakInputPerTurn) !== null) ? Math.max(...turns.map((x) => x.peakInputPerTurn)) : UNAVAILABLE,
    medianInputPerTurn: turns.length && turns.every((x) => Array.isArray(x.inputByTurn) && x.inputByTurn.length === x.turns)
      ? median(turns.flatMap((x) => x.inputByTurn)) : UNAVAILABLE };
}

function comparable(a, b, allowProfileMismatch = false) {
  const x = a.comparability; const y = b.comparability;
  const fields = ['schemaVersion', 'benchmarkVersion', 'requirementsHashes', 'fixtureContentHashes', 'seedHash', 'resultSchemaVersion', 'resultSchemaHash', 'metricDefinitions', 'qualification', 'resultDefinition'];
  const mismatches = fields.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  if (!allowProfileMismatch && x.profile !== y.profile) mismatches.push('profile');
  const profileExperiment = allowProfileMismatch && x.profile !== y.profile && mismatches.length === 0;
  return { directlyComparable: mismatches.length === 0, mismatches, profileExperiment };
}

export function validateMeasurementReport(report) {
  const fail = (message) => { throw new Error(`invalid measurement report: ${message}`); };
  if (!report || report.schemaVersion !== 1 || report.benchmarkId !== 'sentinel-todo' || !Number.isInteger(report.benchmarkVersion)) fail('identity/schema');
  if (!report.run?.id || !['PASS', 'FAIL', 'ABORTED'].includes(report.run.status) || report.run.mode !== 'full') fail('run identity');
  if (!report.provenance?.sourceFunctionalSha256 || !report.provenance?.snapshotSha256) fail('source/snapshot identity');
  const c = report.comparability;
  for (const key of ['schemaVersion', 'benchmarkVersion', 'profile', 'requirementsHashes', 'fixtureContentHashes', 'seedHash', 'resultSchemaVersion', 'resultSchemaHash', 'metricDefinitions', 'qualification', 'resultDefinition']) {
    if (c?.[key] === undefined || c[key] === null || c[key] === '') fail(`comparability.${key}`);
  }
  if (!Array.isArray(report.cases) || !report.cases.length) fail('cases');
  for (const row of report.cases) {
    if (!row.id || !['PASS', 'FAIL', 'ABORTED'].includes(row.status) || !Number.isInteger(row.operations)) fail('case identity/metrics');
    for (const key of ['main', 'runner']) {
      const group = row.telemetry?.[key];
      if (group !== UNAVAILABLE && (!group || !Number.isInteger(group.turns)
        || (group.input !== UNAVAILABLE && !Number.isFinite(group.input)) || (group.output !== UNAVAILABLE && !Number.isFinite(group.output)))) fail(`case ${row.id} telemetry ${key}`);
    }
  }
  if (!report.aggregate || !Number.isInteger(report.aggregate.operations) || !report.aggregate.telemetry) fail('aggregate');
  for (const key of ['main', 'runner']) {
    const group = report.aggregate.telemetry[key];
    if (group !== UNAVAILABLE && (!group || !Number.isInteger(group.turns)
      || (group.input !== UNAVAILABLE && !Number.isFinite(group.input)) || (group.output !== UNAVAILABLE && !Number.isFinite(group.output)))) fail(`aggregate telemetry ${key}`);
  }
  return report;
}

function delta(after, before) {
  return Number.isFinite(after) && Number.isFinite(before) ? after - before : UNAVAILABLE;
}

function fullCoverage(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  return Boolean(match && Number(match[1]) === Number(match[2]));
}

export function compareMeasurements(before, after, allowProfileMismatch = false) {
  validateMeasurementReport(before); validateMeasurementReport(after);
  const compatibility = comparable(before, after, allowProfileMismatch);
  if (!compatibility.directlyComparable && !compatibility.profileExperiment) return { ...compatibility, deltas: UNAVAILABLE };
  const bt = before.aggregate.telemetry; const at = after.aggregate.telemetry;
  const mainComplete = fullCoverage(bt.coverage?.main) && fullCoverage(at.coverage?.main);
  const runnerComplete = fullCoverage(bt.coverage?.runner) && fullCoverage(at.coverage?.runner);
  const allComplete = mainComplete && runnerComplete;
  return { ...compatibility, deltas: {
    g2: Object.fromEntries(['operations', 'recoveryOperations', 'extraRunnerTurns', 'repeatedReviewRounds', 'repeatedExecuteAttempts', 'repeatedValidateAttempts'].map((k) => [k, delta(after.aggregate[k], before.aggregate[k])])),
    g3: { mainInputTokens: mainComplete ? delta(at.main === UNAVAILABLE ? null : at.main.input, bt.main === UNAVAILABLE ? null : bt.main.input) : UNAVAILABLE,
      mainOutputTokens: mainComplete ? delta(at.main === UNAVAILABLE ? null : at.main.output, bt.main === UNAVAILABLE ? null : bt.main.output) : UNAVAILABLE,
      runnerInputTokens: runnerComplete ? delta(at.runner === UNAVAILABLE ? null : at.runner.input, bt.runner === UNAVAILABLE ? null : bt.runner.input) : UNAVAILABLE,
      runnerOutputTokens: runnerComplete ? delta(at.runner === UNAVAILABLE ? null : at.runner.output, bt.runner === UNAVAILABLE ? null : bt.runner.output) : UNAVAILABLE,
      peakInputPerTurn: allComplete ? delta(at.peakInputPerTurn, bt.peakInputPerTurn) : UNAVAILABLE,
      medianInputPerTurn: allComplete ? delta(at.medianInputPerTurn, bt.medianInputPerTurn) : UNAVAILABLE },
  } };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'export') {
    const report = validateMeasurementReport(await measurement(required(args, 'run')));
    for (const row of report.cases) for (const group of ['main', 'runner']) {
      if (row.telemetry[group] !== UNAVAILABLE) delete row.telemetry[group].inputByTurn;
    }
    const output = path.resolve(ROOT, required(args, 'output'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`measurement exported: ${path.relative(ROOT, output)}`);
  } else if (command === 'compare') {
    const before = await json(path.resolve(ROOT, required(args, 'before'))); const after = await json(path.resolve(ROOT, required(args, 'after')));
    const result = compareMeasurements(before, after, args['profile-experiment'] === 'true');
    console.log(JSON.stringify(result, null, 2));
    if (!result.directlyComparable && !result.profileExperiment) process.exitCode = 2;
  } else throw new Error('usage: benchmark-measurement.mjs export --run <id> --output <path> | compare --before <path> --after <path> [--profile-experiment true]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
