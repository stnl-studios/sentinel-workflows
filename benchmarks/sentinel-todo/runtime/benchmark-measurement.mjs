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

async function currentFinalizerRaw(dir, state, journal, id) {
  const recorded = state?.finalizer?.rawPath;
  const resumed = (state?.finalizerHistory?.length ?? 0) > 0;
  if (recorded === undefined && !resumed) return optionalJson(path.join(dir, 'raw.json'));
  if (recorded === null && state.finalizer.exitCode !== 0) return null;
  const names = resumed ? [] : [path.join(dir, 'raw.json')];
  if (Array.isArray(state?.operations)) names.push(path.join(dir, `raw-resume-${state.operations.length}.json`));
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded) || !names.includes(recorded))
    throw new Error(`case ${id} finalizer path is missing or invalid`);
  const [caseStat, rawStat, realDir, realRaw] = await Promise.all([
    fs.lstat(dir), fs.lstat(recorded), fs.realpath(dir), fs.realpath(recorded),
  ]).catch((error) => { throw new Error(`case ${id} finalizer file is unavailable: ${error.code ?? error.message}`); });
  if (!caseStat.isDirectory() || caseStat.isSymbolicLink() || !rawStat.isFile() || rawStat.isSymbolicLink()
    || realRaw !== path.join(realDir, path.basename(recorded)))
    throw new Error(`case ${id} finalizer file is outside its authorized case`);
  const raw = await json(recorded);
  if (state.caseId !== id || journal?.caseId !== id || raw.caseId !== id
    || !['full', 'case', 'focal'].includes(raw.runMode) || raw.runMode !== journal.runMode
    || !Number.isInteger(raw.operations?.total))
    throw new Error(`case ${id} finalizer identity or operation count is invalid`);
  return raw;
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
  if (run.runId !== runId || !['full', 'case', 'focal'].includes(run.mode)
    || !['PASS', 'FAIL', 'ABORTED', 'BLOCKED', 'CANCELLED', 'PAUSED_BUDGET_OR_QUOTA', 'FOCAL_STOP'].includes(run.status)
    || !Array.isArray(run.cases) || run.cases.length === 0 || new Set(run.cases).size !== run.cases.length
    || run.cases.some((id) => !['A', 'B', 'C'].includes(id)) || (run.mode !== 'full' && run.cases.length !== 1)) {
    throw new Error('run must be terminal with a supported mode and matching identity');
  }
  const snapshotExists = await fs.stat(path.join(runRoot, 'snapshot.json')).then(() => true, () => false);
  let snapshot = null; let config = null;
  if (snapshotExists) {
    snapshot = await assertSnapshotIntegrity(runRoot, { checkSource: false });
    if (run.snapshot?.snapshotSha256 !== snapshot.snapshotSha256 || run.snapshot?.sourceFunctionalSha256 !== snapshot.sourceFunctionalSha256) throw new Error('run and frozen snapshot identities differ');
    const frozenIdentity = await frozenSourceIdentity(path.join(runRoot, 'snapshot'));
    if (frozenIdentity.sha256 !== snapshot.sourceFunctionalSha256 || frozenIdentity.fileCount !== snapshot.sourceFileCount) throw new Error('frozen source content does not match its recorded functional identity');
    config = await json(path.join(runRoot, 'snapshot/benchmarks/sentinel-todo/benchmark.json'));
  } else throw new Error('terminal run is missing its frozen snapshot');
  const cases = [];
  const summary = await optionalJson(path.join(runRoot, 'summary.json'));
  if (!summary || summary.runId !== runId || summary.status !== run.status || summary.mode !== run.mode) throw new Error('run summary identity differs from run.json');
  const caseIds = run.cases ?? [];
  for (const id of caseIds) {
    const dir = path.join(runRoot, `case-${id.toLowerCase()}`);
    const [state, journal] = await Promise.all([
      optionalJson(path.join(dir, 'case-state.json')),
      optionalJson(path.join(dir, 'journal.json')),
    ]);
    const raw = await currentFinalizerRaw(dir, state, journal, id);
    const result = summary.cases?.[id] ?? {};
    if (!raw && !state && !journal) {
      if (result.status !== 'NOT_RUN') {
        if (!result.status) throw new Error(`case ${id} is missing its official summary state`);
        cases.push({ id, status: result.status, blocker: result.terminal?.blocker ?? result.blocker ?? UNAVAILABLE, terminalResult: result.terminal?.result ?? UNAVAILABLE,
          blockingOperation: UNAVAILABLE, operations: result.operations ?? UNAVAILABLE, mainTurns: result.mainTurns ?? UNAVAILABLE, runnerTurns: result.runnerTurns ?? UNAVAILABLE, execution: UNAVAILABLE, specClosed: UNAVAILABLE,
          finalizer: UNAVAILABLE, finalizerExitCode: UNAVAILABLE, finalTestsPassed: UNAVAILABLE, finalTestCommand: UNAVAILABLE, finalTestExitCode: UNAVAILABLE, profileMismatches: UNAVAILABLE,
          provider: UNAVAILABLE, authMode: UNAVAILABLE, isolation: UNAVAILABLE, findingsCycles: UNAVAILABLE, recoveryOperations: UNAVAILABLE,
          extraRunnerTurns: UNAVAILABLE, repeatedReviewRounds: UNAVAILABLE, durationMs: UNAVAILABLE, slices: UNAVAILABLE,
          operationCounts: UNAVAILABLE, operationsBySlice: UNAVAILABLE, operationDurations: UNAVAILABLE, repeatedAttemptsBySlice: UNAVAILABLE,
          telemetry: { coverage: { main: `0/${result.mainTurns ?? UNAVAILABLE}`, runner: `0/${result.runnerTurns ?? UNAVAILABLE}` }, main: UNAVAILABLE, runner: UNAVAILABLE } });
        continue;
      }
      cases.push({ id, status: 'NOT_RUN', blocker: UNAVAILABLE, terminalResult: 'NOT_RUN', blockingOperation: UNAVAILABLE,
        operations: 0, mainTurns: 0, runnerTurns: 0, execution: UNAVAILABLE, specClosed: UNAVAILABLE,
        finalizer: UNAVAILABLE, finalizerExitCode: UNAVAILABLE, finalTestsPassed: UNAVAILABLE, finalTestCommand: UNAVAILABLE, finalTestExitCode: UNAVAILABLE, profileMismatches: UNAVAILABLE,
        provider: UNAVAILABLE, authMode: UNAVAILABLE, isolation: UNAVAILABLE, findingsCycles: UNAVAILABLE, recoveryOperations: 0,
        extraRunnerTurns: 0, repeatedReviewRounds: 0, durationMs: UNAVAILABLE, slices: UNAVAILABLE,
        operationCounts: Object.fromEntries(['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'REPLAN', 'SPEC_RESUME', 'REVIEW_PLAN', 'REVIEW_TASKS'].map((key) => [key, 0])),
        operationsBySlice: {}, operationDurations: [], repeatedAttemptsBySlice: {},
        telemetry: { coverage: { main: '0/0', runner: '0/0' }, main: UNAVAILABLE, runner: UNAVAILABLE } });
      continue;
    }
    if (!state || !journal || state.status === 'ACTIVE' || !state.endedAt) throw new Error(`case ${id} is incomplete`);
    if (!Array.isArray(journal.events)) throw new Error(`case ${id} operation journal is unavailable`);
    const events = journal.events;
    const summaryCase = result;
    if (!summaryCase.status || summaryCase.status !== state.status || (Number.isInteger(summaryCase.operations) && summaryCase.operations !== events.length)
      || (raw && Number.isInteger(raw.operations?.total) && raw.operations.total !== events.length)
      || (summaryCase.mainTurns !== undefined && summaryCase.mainTurns !== state.mainTurns) || (summaryCase.runnerTurns !== undefined && summaryCase.runnerTurns !== state.runnerTurns)) {
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
    const tokenStats = (rows, expectedTurns) => {
      if (!rows.length) return UNAVAILABLE;
      const inputs = inputValues(rows); const input = sum(rows, 'input');
      const output = sum(rows, 'output'); const fullCoverage = numeric(expectedTurns) !== null && rows.length === expectedTurns;
      const observedSum = (field) => rows.length && rows.every((o) => numeric(o.delta[field]) !== null) ? rows.reduce((n, o) => n + o.delta[field], 0) : UNAVAILABLE;
      return { turns: rows.length, input: fullCoverage ? input : UNAVAILABLE, output: fullCoverage ? output : UNAVAILABLE,
        cachedInput: fullCoverage ? sum(rows, 'cachedInput') : UNAVAILABLE, reasoningOutput: fullCoverage ? sum(rows, 'reasoningOutput') : UNAVAILABLE,
        observedInput: observedSum('input'), observedOutput: observedSum('output'),
        peakInputPerTurn: inputs ? Math.max(...inputs) : UNAVAILABLE, medianInputPerTurn: inputs ? median(inputs) : UNAVAILABLE,
        meanInputPerTurn: fullCoverage && inputs ? input / rows.length : UNAVAILABLE, inputByTurn: inputs ?? [] };
    };
    cases.push({
      id, status: state.status, blocker: state.terminal?.blocker ?? UNAVAILABLE,
      terminalResult: state.terminal?.result ?? UNAVAILABLE,
      blockingOperation: state.status !== 'PASS' && state.operations?.length ? { operation: state.operations.at(-1).operation ?? UNAVAILABLE,
        slice: state.operations.at(-1).slice ?? UNAVAILABLE, result: state.operations.at(-1).outcome?.result ?? UNAVAILABLE } : UNAVAILABLE,
      operations: events.length, mainTurns: state.mainTurns ?? UNAVAILABLE,
      runnerTurns: state.runnerTurns ?? UNAVAILABLE, execution: raw?.finalExecutionState ?? UNAVAILABLE,
      specClosed: raw?.specClosed ?? UNAVAILABLE, finalizer: state.finalizer?.exitCode === 0 ? 'PASS' : state.finalizer?.exitCode !== undefined ? 'FAIL' : UNAVAILABLE,
      finalizerExitCode: state.finalizer?.exitCode ?? UNAVAILABLE,
      finalTestsPassed: raw?.finalTests?.passed ?? raw?.finalTestsPassed ?? UNAVAILABLE,
      finalTestCommand: typeof raw?.finalTests?.command === 'string' && raw.finalTests.command.length <= 120 && /^[a-zA-Z0-9._ -]+$/u.test(raw.finalTests.command) ? raw.finalTests.command : UNAVAILABLE,
      finalTestExitCode: raw?.finalTests?.exitCode ?? UNAVAILABLE,
      profileMismatches: raw?.modelUse?.profileMismatches ?? UNAVAILABLE,
      provider: state.isolation?.provider ?? UNAVAILABLE,
      authMode: state.isolation?.authMode ?? UNAVAILABLE,
      isolation: state.isolation?.filesystemSandbox ?? UNAVAILABLE,
      findingsCycles: raw?.operations?.findingsCycles ?? UNAVAILABLE, recoveryOperations: counts.APPLY_FINDINGS + counts.REPLAN + counts.SPEC_RESUME,
      extraRunnerTurns: numeric(state.runnerTurns) === null ? UNAVAILABLE : Math.max(0, state.runnerTurns - runnerBearingOperations),
      repeatedReviewRounds: Math.max(0, counts.REVIEW_PLAN - 1) + Math.max(0, counts.REVIEW_TASKS - 1),
      durationMs: state.startedAt && state.endedAt ? Date.parse(state.endedAt) - Date.parse(state.startedAt) : UNAVAILABLE,
      slices: raw?.decomposition?.slices ?? UNAVAILABLE, operationCounts: counts, operationsBySlice: bySlice,
      operationDurations: events.map((event) => ({ operation: event.operation, slice: event.slice ?? null,
        durationMs: numeric(event.durationMs) ?? UNAVAILABLE })),
      repeatedAttemptsBySlice: Object.fromEntries(Object.entries(bySlice).map(([slice, v]) => [slice,
        { execute: Math.max(0, v.execute - 1), validate: Math.max(0, v.validate - 1) }])),
      telemetry: { coverage: { main: `${main.length}/${state.mainTurns ?? UNAVAILABLE}`, runner: `${runner.length}/${state.runnerTurns ?? UNAVAILABLE}` }, main: tokenStats(main, state.mainTurns), runner: tokenStats(runner, state.runnerTurns) },
    });
  }
  const caseById = Object.fromEntries((config?.cases ?? []).map((c) => [c.id, c]));
  const resultSchemaHash = config ? `sha256:${createHash('sha256').update(await fs.readFile(path.join(runRoot, 'snapshot/benchmarks/sentinel-todo', config.schemas.result))).digest('hex')}` : UNAVAILABLE;
  return {
    schemaVersion: 1, benchmarkId: config?.benchmarkId ?? 'sentinel-todo', benchmarkVersion: config?.benchmarkVersion ?? UNAVAILABLE,
    resultDefinition: run.mode === 'full' ? 'full run is PASS when manager status is PASS and all included cases have passing finalizers'
      : `${run.mode} run records only the selected case; it is not a full-run conclusion`,
    run: { id: runId, status: run.status, mode: run.mode, profile: run.profile ?? UNAVAILABLE, startedAt: run.startedAt, endedAt: run.endedAt ?? UNAVAILABLE },
    provenance: { baseSha: snapshot?.baseSha ?? UNAVAILABLE, dirty: snapshot?.dirty ?? UNAVAILABLE, functionalDiffSha256: snapshot?.functionalDiffSha256 ?? UNAVAILABLE,
      ...(snapshot?.executionMode === 'OFFLINE_TEST_ONLY' ? { executionMode: 'OFFLINE_TEST_ONLY' } : {}),
      sourceFunctionalSha256: snapshot?.sourceFunctionalSha256 ?? UNAVAILABLE, snapshotSha256: snapshot?.snapshotSha256 ?? UNAVAILABLE, snapshotCreatedAt: snapshot?.createdAt ?? UNAVAILABLE },
    comparability: { schemaVersion: 1, benchmarkVersion: config?.benchmarkVersion ?? UNAVAILABLE, profile: run.profile ?? UNAVAILABLE,
      requirementsHashes: Object.fromEntries(run.cases.map((id) => [id, caseById[id]?.requirementsHash ?? UNAVAILABLE])),
      fixtureContentHashes: Object.fromEntries(run.cases.map((id) => [id, caseById[id]?.fixtureContentHash ?? UNAVAILABLE])),
      seedHash: config.integrity?.seedContentHash ?? UNAVAILABLE,
      resultSchemaVersion: config?.schemaVersions.result ?? UNAVAILABLE, resultSchemaHash,
      metricDefinitions: 'g2-operation-counts-v1;g3-attributable-usage-delta-v1',
      qualification: { harnessContractVersion: config?.productionPilot?.qualification?.harnessContractVersion ?? UNAVAILABLE,
        providerVersion: config?.productionPilot?.qualification?.providerVersion ?? UNAVAILABLE,
        capabilitiesHash: config?.productionPilot?.qualification?.capabilitiesHash ?? UNAVAILABLE,
        sandboxProbeStatus: config?.productionPilot?.qualification?.sandboxProbeStatus ?? UNAVAILABLE,
        sandboxProbeEvidenceSha256: config?.productionPilot?.qualification?.sandboxProbeEvidenceSha256 ?? UNAVAILABLE }, resultDefinition: `${run.mode}-pass-v1` },
    cases,
    aggregate: { operations: sumKnown(cases.map((c) => c.operations)), mainTurns: sumKnown(cases.map((c) => c.mainTurns)),
      runnerTurns: sumKnown(cases.map((c) => c.runnerTurns)), recoveryOperations: sumKnown(cases.map((c) => c.recoveryOperations)),
      happyPathOperations: cases.every((c) => numeric(c.operations) !== null && numeric(c.recoveryOperations) !== null) ? cases.reduce((n, c) => n + c.operations - c.recoveryOperations, 0) : UNAVAILABLE,
      extraRunnerTurns: sumKnown(cases.map((c) => c.extraRunnerTurns)), repeatedReviewRounds: sumKnown(cases.map((c) => c.repeatedReviewRounds)),
      repeatedExecuteAttempts: cases.every((c) => c.repeatedAttemptsBySlice !== UNAVAILABLE) ? cases.reduce((n, c) => n + Object.values(c.repeatedAttemptsBySlice).reduce((x, v) => x + v.execute, 0), 0) : UNAVAILABLE,
      repeatedValidateAttempts: cases.every((c) => c.repeatedAttemptsBySlice !== UNAVAILABLE) ? cases.reduce((n, c) => n + Object.values(c.repeatedAttemptsBySlice).reduce((x, v) => x + v.validate, 0), 0) : UNAVAILABLE,
      wallDurationMs: run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : UNAVAILABLE,
      summedCaseDurationMs: cases.every((c) => numeric(c.durationMs) !== null) ? cases.reduce((n, c) => n + c.durationMs, 0) : UNAVAILABLE,
      telemetry: aggregateTelemetry(cases) },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sumKnown(values) { return values.every((v) => numeric(v) !== null) ? values.reduce((a, b) => a + b, 0) : UNAVAILABLE; }

function aggregateTelemetry(cases) {
  const collect = (key) => cases.flatMap((c) => c.telemetry[key] === UNAVAILABLE ? [] : [c.telemetry[key]]);
  const main = collect('main'); const runner = collect('runner');
  const agg = (groups) => {
    if (!groups.length) return UNAVAILABLE;
    const sumFields = (key) => groups.every((x) => Number.isFinite(x[key])) ? groups.reduce((n, x) => n + x[key], 0) : UNAVAILABLE;
    const inputValues = groups.every((x) => Array.isArray(x.inputByTurn) && x.inputByTurn.length === x.turns) ? groups.flatMap((x) => x.inputByTurn) : null;
    const input = sumFields('input'); const turns = groups.reduce((n, x) => n + x.turns, 0);
    return { turns, input, output: sumFields('output'), cachedInput: sumFields('cachedInput'), reasoningOutput: sumFields('reasoningOutput'),
      observedInput: groups.every((x) => Number.isFinite(x.observedInput)) ? groups.reduce((n, x) => n + x.observedInput, 0) : UNAVAILABLE,
      observedOutput: groups.every((x) => Number.isFinite(x.observedOutput)) ? groups.reduce((n, x) => n + x.observedOutput, 0) : UNAVAILABLE,
      peakInputPerTurn: inputValues ? Math.max(...inputValues) : UNAVAILABLE,
      medianInputPerTurn: inputValues ? median(inputValues) : UNAVAILABLE,
      meanInputPerTurn: inputValues ? input / turns : UNAVAILABLE };
  };
  const turns = [...main, ...runner];
  const coverage = (groups, field) => {
    const denominator = cases.map((c) => numeric(c[field])).filter((v) => v !== null);
    const numerator = groups.reduce((n, x) => n + x.turns, 0);
    return denominator.length === cases.length ? `${numerator}/${denominator.reduce((n, x) => n + x, 0)}` : `${numerator}/${UNAVAILABLE}`;
  };
  const coverageByRole = { main: coverage(main, 'mainTurns'), runner: coverage(runner, 'runnerTurns') };
  const totals = { main: agg(main), runner: agg(runner) };
  for (const role of ['main', 'runner']) {
    if (totals[role] !== UNAVAILABLE && !fullCoverage(coverageByRole[role])) {
      for (const field of ['input', 'output', 'cachedInput', 'reasoningOutput', 'meanInputPerTurn']) totals[role][field] = UNAVAILABLE;
    }
  }
  return { coverage: coverageByRole, ...totals,
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
  if (!report || report.schemaVersion !== 1 || report.benchmarkId !== 'sentinel-todo' || (report.benchmarkVersion !== UNAVAILABLE && !Number.isInteger(report.benchmarkVersion))) fail('identity/schema');
  if (!report.run?.id || !['PASS', 'FAIL', 'ABORTED', 'BLOCKED', 'CANCELLED', 'PAUSED_BUDGET_OR_QUOTA', 'FOCAL_STOP'].includes(report.run.status)
    || !['full', 'case', 'focal'].includes(report.run.mode)) fail('run identity');
  if (!report.provenance?.sourceFunctionalSha256 || !report.provenance?.snapshotSha256) fail('source/snapshot identity');
  const c = report.comparability;
  for (const key of ['schemaVersion', 'benchmarkVersion', 'profile', 'requirementsHashes', 'fixtureContentHashes', 'seedHash', 'resultSchemaVersion', 'resultSchemaHash', 'metricDefinitions', 'qualification', 'resultDefinition']) {
    if (c?.[key] === undefined || c[key] === null || c[key] === '') fail(`comparability.${key}`);
  }
  if (!Array.isArray(report.cases) || !report.cases.length) fail('cases');
  if (report.run.mode !== 'full' && report.cases.length !== 1) fail('selected case scope');
  for (const row of report.cases) {
    if (!row.id || !['PASS', 'FAIL', 'ABORTED', 'BLOCKED', 'CANCELLED', 'PAUSED_BUDGET_OR_QUOTA', 'FOCAL_STOP', 'NOT_RUN'].includes(row.status)
      || (row.operations !== UNAVAILABLE && !Number.isInteger(row.operations))) fail('case identity/metrics');
    for (const key of ['main', 'runner']) {
      const group = row.telemetry?.[key];
      if (group !== UNAVAILABLE && (!group || !Number.isInteger(group.turns)
        || (group.input !== UNAVAILABLE && !Number.isFinite(group.input)) || (group.output !== UNAVAILABLE && !Number.isFinite(group.output)))) fail(`case ${row.id} telemetry ${key}`);
    }
  }
  if (!report.aggregate || (report.aggregate.operations !== UNAVAILABLE && !Number.isInteger(report.aggregate.operations)) || !report.aggregate.telemetry) fail('aggregate');
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
  if ([before, after].some((report) => report.provenance?.executionMode === 'OFFLINE_TEST_ONLY')) return {
    directlyComparable: false, profileExperiment: false, mismatches: ['OFFLINE_TEST_ONLY provider evidence'],
    conclusion: 'TEST-ONLY; ineligible for real proof or baseline', deltas: UNAVAILABLE };
  const compatibility = comparable(before, after, allowProfileMismatch);
  if (!compatibility.directlyComparable && !compatibility.profileExperiment) return { ...compatibility, deltas: UNAVAILABLE };
  const complete = (r) => r.run.mode === 'full' && r.run.status === 'PASS' && r.cases.every((c) => c.status === 'PASS' && c.finalizer === 'PASS'
    && c.finalTestsPassed === true && c.specClosed === true && c.execution === 'COMPLETE');
  if (!complete(before) || !complete(after)) return { ...compatibility, directlyComparable: false,
    mismatches: [...compatibility.mismatches, 'incomplete full-run conclusion'], conclusion: 'partial-run; no savings conclusion', deltas: UNAVAILABLE };
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

export async function exportMeasurement(runId) {
  const report = validateMeasurementReport(await measurement(runId));
  for (const row of report.cases) for (const key of ['main', 'runner']) {
    if (row.telemetry[key] !== UNAVAILABLE) delete row.telemetry[key].inputByTurn;
  }
  return report;
}

function markdown(report, comparison, historyRef) {
  const lines = [
    '# Sentinel todo benchmark measurement', '', `- Run: ${report.run.id}`,
    `- Status: ${report.run.status}; mode: ${report.run.mode}; profile: ${report.run.profile}`,
    `- Time: ${report.run.startedAt ?? UNAVAILABLE} → ${report.run.endedAt}`,
    `- HEAD: ${report.provenance.baseSha}; dirty: ${report.provenance.dirty}; functional diff: ${report.provenance.functionalDiffSha256}`,
    `- Source identity: ${report.provenance.sourceFunctionalSha256}; snapshot: ${report.provenance.snapshotSha256}`,
    `- Snapshot created: ${report.provenance.snapshotCreatedAt}`, '',
    '| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |',
    '|---|---|---|---|---|---|---|---:|---:|---:|---|',
  ];
  for (const c of report.cases) lines.push(`| ${c.id} | ${c.status} | ${c.blocker} | ${c.finalizer} (exit ${c.finalizerExitCode}) | ${c.finalTestsPassed} | ${c.specClosed} | ${c.execution} | ${c.operations} | ${c.mainTurns} / ${c.runnerTurns} | ${c.durationMs} | ${Array.isArray(c.slices) ? c.slices.join(', ') : c.slices} |`);
  lines.push('', '## Measured totals', '',
    `- Operations: ${report.aggregate.operations}; recovery operations: ${report.aggregate.recoveryOperations}; happy path operations: ${report.aggregate.happyPathOperations}`,
    `- Main turns: ${report.aggregate.mainTurns}; runner turns: ${report.aggregate.runnerTurns}; extra runner turns: ${report.aggregate.extraRunnerTurns}`,
    `- Repeated reviews: ${report.aggregate.repeatedReviewRounds}; repeated execute/validate: ${report.aggregate.repeatedExecuteAttempts} / ${report.aggregate.repeatedValidateAttempts}`,
    `- Duration total / summed cases (ms): ${report.aggregate.wallDurationMs} / ${report.aggregate.summedCaseDurationMs}`,
    `- Telemetry coverage main / runner: ${report.aggregate.telemetry.coverage.main} / ${report.aggregate.telemetry.coverage.runner}`);
  for (const role of ['main', 'runner']) {
    const group = report.aggregate.telemetry[role];
    lines.push(`- ${role} tokens (input/output/cached input/reasoning output): ${group === UNAVAILABLE ? UNAVAILABLE : `${group.input} / ${group.output} / ${group.cachedInput} / ${group.reasoningOutput}`}`);
    lines.push(`- ${role} observed input/output tokens: ${group === UNAVAILABLE ? UNAVAILABLE : `${group.observedInput ?? UNAVAILABLE} / ${group.observedOutput ?? UNAVAILABLE}`}`);
  }
  lines.push('- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.');
  lines.push('', '## Comparison', '',
    `- Reason: ${comparison?.conclusion ?? (comparison?.directlyComparable ? 'compatible reports' : comparison?.mismatches?.join(', ') ?? UNAVAILABLE)}`,
    `- Deltas versus baseline-v1: ${comparison?.deltas === UNAVAILABLE || !comparison ? UNAVAILABLE : JSON.stringify(comparison.deltas)}`,
    `- Historical JSON: [${report.run.id}.json](${historyRef})`, '', '## Case evidence', '');
  for (const c of report.cases) {
    lines.push(`- ${c.id}: ${c.status}; blocker ${c.blocker}; terminal ${c.terminalResult}; blocking operation ${JSON.stringify(c.blockingOperation)}; finalizer ${c.finalizer}; final tests ${c.finalTestsPassed} (${c.finalTestCommand}, exit ${c.finalTestExitCode}); operations ${JSON.stringify(c.operationCounts)}; slices ${JSON.stringify(c.operationsBySlice)}; telemetry coverage main ${c.telemetry.coverage.main}, runner ${c.telemetry.coverage.runner}.`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeAtomic(file, bytes, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (exclusive) {
    const staged = `${file}.${process.pid}-${randomSuffix()}.stage`;
    try {
      await fs.writeFile(staged, bytes, { flag: 'wx' });
      try { await fs.link(staged, file); return; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(file);
        if (existing.equals(Buffer.from(bytes))) return;
        throw new Error(`measurement history collision; preserved existing evidence: ${file}`);
      }
    }
    catch (error) {
      throw error;
    } finally { await fs.rm(staged, { force: true }); }
  }
  const temp = `${file}.${process.pid}-${randomSuffix()}.tmp`;
  try { await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

function randomSuffix() { return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10); }

export async function publishMeasurement(report, { root = path.join(ROOT, 'benchmarks/sentinel-todo/measurements'), updateLatest = true } = {}) {
  report = validateMeasurementReport(report);
  if (!/^[a-z0-9][a-z0-9-]{7,}$/u.test(report.run.id)) throw new Error('invalid run id');
  const baselinePath = path.resolve(root, '../baselines/baseline-v1.json');
  let comparison = { directlyComparable: false, mismatches: ['baseline-v1 unavailable'], conclusion: 'baseline-v1 unavailable', deltas: UNAVAILABLE };
  try { comparison = compareMeasurements(await json(baselinePath), report); }
  catch (error) { comparison = { directlyComparable: false,
    mismatches: [error.code === 'ENOENT' ? 'baseline-v1 unavailable' : `baseline-v1 invalid: ${error.message}`],
    conclusion: error.code === 'ENOENT' ? 'baseline-v1 unavailable' : 'baseline-v1 invalid', deltas: UNAVAILABLE }; }
  report = { ...report, comparisonToBaseline: comparison };
  const historyPath = path.join(root, `${report.run.id}.json`);
  const historyBytes = `${JSON.stringify(report, null, 2)}\n`;
  const latestPath = path.join(root, 'latest.json');
  const latestMdPath = path.join(root, 'latest.md');
  const mdBytes = markdown(report, comparison, path.basename(historyPath));
  await writeAtomic(historyPath, historyBytes, { exclusive: true });
  if (updateLatest) {
    const jsonTemp = `${latestPath}.${process.pid}-${randomSuffix()}.tmp`;
    const mdTemp = `${latestMdPath}.${process.pid}-${randomSuffix()}.tmp`;
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(jsonTemp, historyBytes, { flag: 'wx' });
      await fs.writeFile(mdTemp, mdBytes, { flag: 'wx' });
      await fs.rename(jsonTemp, latestPath);
      await fs.rename(mdTemp, latestMdPath);
    } finally { await fs.rm(jsonTemp, { force: true }); await fs.rm(mdTemp, { force: true }); }
  }
  return { report, historyPath, latestPath: updateLatest ? latestPath : null, latestMdPath: updateLatest ? latestMdPath : null };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'export') {
    const report = await exportMeasurement(required(args, 'run'));
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
