#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'sentinel-todo');
const RUNTIME = path.join(BENCHMARK, 'runtime', 'benchmark.mjs');
const SEED = path.join(BENCHMARK, 'seed');
const CLOSED_SPEC_FIXTURE = path.join(
  ROOT, 'skills', 'workflows', 'stnl-spec-lifecycle-manager',
  'examples', 'validator-fixtures', 'closed', 'feature_spec.md',
);
const READY_SPEC_FIXTURE = path.join(
  ROOT, 'skills', 'workflows', 'stnl-spec-lifecycle-manager',
  'examples', 'validator-fixtures', 'ready',
);
const SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', shell: false }).stdout.trim();
const PHASES = ['SPEC', 'PLAN', 'TASKS', 'EXECUTE', 'REVIEW_VALIDATE'];

function run(command, args, cwd = ROOT) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, timeout: 60_000 });
}

function cli(args) {
  return run(process.execPath, [RUNTIME, ...args]);
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

async function temporaryRoot(t, label) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), `${label} ü `));
  const root = await fs.realpath(created);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function event(journal, operation, phase, model, effort, result = 'PASS', extra = []) {
  return cli([
    'journal-event', '--journal', journal, '--operation', operation, '--phase', phase,
    '--model', model, '--effort', effort, '--result', result, ...extra,
  ]);
}

async function initJournal(file, caseId = 'A', runMode = 'case') {
  requireSuccess(cli([
    'journal-init', '--output', file, '--case', caseId, '--sentinel-sha', SHA,
    '--run-mode', runMode, '--production-profile', 'production-v1',
  ]), 'journal-init');
}

async function writeSyntheticArtifacts(workspace, caseId = 'A', { closed = true, invalidClosed = false } = {}) {
  const spec = path.join(workspace, 'specs', `benchmark-case-${caseId.toLowerCase()}`);
  await fs.mkdir(path.join(spec, 'execution', 'plans'), { recursive: true });
  await fs.mkdir(path.join(spec, 'execution', 'tasks'), { recursive: true });
  if (closed && !invalidClosed) await fs.copyFile(CLOSED_SPEC_FIXTURE, path.join(spec, 'feature_spec.md'));
  else if (!closed) {
    await fs.copyFile(path.join(READY_SPEC_FIXTURE, 'feature_spec.md'), path.join(spec, 'feature_spec.md'));
    await fs.cp(path.join(READY_SPEC_FIXTURE, 'shared'), path.join(spec, 'shared'), { recursive: true });
  } else await fs.writeFile(path.join(spec, 'feature_spec.md'), `# File Purpose Header

\`\`\`yaml
purpose: Synthetic collector fixture.
status: ${closed ? 'closed' : 'ready'}
read_when: Testing the benchmark collector.
do_not_read_when: Running a model benchmark.
contains: Synthetic benchmark evidence.
owner: benchmark-contract-test
update_policy: Test fixture only.
\`\`\`

# Synthetic SPEC
`, 'utf8');
  await fs.writeFile(path.join(spec, 'execution', 'plan.md'), '# Global plan\n\nOne global plan.\n', 'utf8');
  await fs.writeFile(path.join(spec, 'execution', 'plans', 'slice-01.md'), '# Slice 01\n\nImplement two tasks.\n', 'utf8');
  await fs.writeFile(path.join(spec, 'execution', 'tasks.md'), '# Global tasks\n\nOne slice.\n', 'utf8');
  await fs.writeFile(path.join(spec, 'execution', 'tasks', 'slice-01.md'), `# Slice 01 tasks

## Checklist

- [x] Implement behavior
- [x] Add regression tests

## Final Result

- PASS
`, 'utf8');
  return spec;
}

async function completeJournal(file, { mismatch = false, includeComplete = true, regressAfterComplete = false } = {}) {
  requireSuccess(event(file, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high'), 'SPEC_INIT');
  requireSuccess(event(file, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'SPEC_READINESS');
  requireSuccess(event(file, 'PLAN', 'PLAN', mismatch ? 'GPT-5.6-Sol' : 'GPT-5.6-Terra', mismatch ? 'xhigh' : 'high'), 'PLAN');
  requireSuccess(event(file, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'REVIEW_PLAN');
  requireSuccess(event(file, 'MATERIALIZE_TASKS', 'TASKS', 'GPT-5.6-Terra', 'high'), 'MATERIALIZE_TASKS');
  requireSuccess(event(file, 'REVIEW_TASKS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'REVIEW_TASKS');
  requireSuccess(event(file, 'EXECUTE_SLICE', 'EXECUTE', 'GPT-5.6-Luna', 'high', 'PASS', ['--slice', 'slice-01']), 'EXECUTE_SLICE');
  const validateExtra = ['--slice', 'slice-01'];
  if (includeComplete) validateExtra.push('--resulting-state', 'COMPLETE');
  requireSuccess(event(file, 'VALIDATE_SLICE', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', validateExtra), 'VALIDATE_SLICE');
  if (regressAfterComplete) {
    requireSuccess(event(file, 'VALIDATE_SLICE', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'NEEDS_FIX', [
      '--slice', 'slice-01', '--round', '2', '--resulting-state', 'NEEDS_FIX',
    ]), 'regressed VALIDATE_SLICE');
  }
  requireSuccess(event(file, 'SPEC_CLOSE', 'SPEC', 'GPT-5.6-Terra', 'high', 'PASS', ['--resulting-state', 'SPEC_CLOSED']), 'SPEC_CLOSE');
}

test('B01 — manifest has bounded cases, profiles, paths, and schemas', async () => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  assert.equal(configuration.benchmarkId, 'sentinel-todo');
  assert.equal(configuration.benchmarkVersion, 1);
  assert.deepEqual(configuration.cases.map((entry) => entry.id), ['A', 'B', 'C']);
  assert.equal(new Set(configuration.cases.map((entry) => entry.id)).size, 3);
  for (const item of configuration.cases) {
    await fs.access(path.join(BENCHMARK, item.sourcePath));
    assert.deepEqual(Object.keys(configuration.productionProfile.cases[item.id]), PHASES);
    for (const dispatch of Object.values(configuration.productionProfile.cases[item.id])) {
      assert.match(dispatch.model, /^GPT-5\.6-(?:Sol|Terra|Luna)$/u);
      assert.ok(['low', 'medium', 'high', 'xhigh'].includes(dispatch.effort));
    }
    for (const budget of Object.values(item.budgets)) assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 100);
  }
  for (const schema of Object.values(configuration.schemas)) await fs.access(path.join(BENCHMARK, schema));
  requireSuccess(cli(['verify']), 'benchmark verify');
});

test('B02 — seed is dependency-free, complete, and green', async () => {
  const packageDocument = await readJson(path.join(SEED, 'package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(packageDocument[field], undefined);
  }
  for (const relative of [
    'README.md', 'src/todo-service.mjs', 'src/todo-store.mjs', 'src/validation.mjs', 'src/cli.mjs',
    'test/todo-service.test.mjs', 'test/todo-store.test.mjs', 'test/cli.test.mjs',
  ]) await fs.access(path.join(SEED, relative));
  requireSuccess(run(process.execPath, ['--test'], SEED), 'seed tests');
});

test('B03 — Cases are independent requirements sources without profile or rubric leakage', async () => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  const sources = [];
  for (const item of configuration.cases) {
    const text = await fs.readFile(path.join(BENCHMARK, item.sourcePath), 'utf8');
    sources.push(text);
    assert.doesNotMatch(text, /GPT|Terra|Luna|Sol|production-v1|benchmark rubric|expected (?:slice|task)/iu);
  }
  assert.equal(new Set(sources).size, 3);
  assert.doesNotMatch(sources[1], /--completed|--pending|archive|unarchive/iu);
  assert.doesNotMatch(sources[2], /priority|--completed|--pending/iu);
});

test('B04 — prepare is reproducible, isolated, locally configured, and clean', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark prepare');
  const seedBefore = await import(`file://${RUNTIME}`).then((module) => module.contentHash(SEED));
  const outputs = {};
  for (const name of ['A-one', 'A-two', 'B-one', 'C-one']) {
    const caseId = name[0];
    const output = path.join(root, name);
    const prepared = requireSuccess(cli(['prepare', '--case', caseId, '--output', output]), `prepare ${name}`);
    outputs[name] = JSON.parse(prepared.stdout);
    assert.equal(outputs[name].gitWorkingTreeClean, true);
    assert.equal(outputs[name].gitConfigLocal, true);
    const specsParent = await fs.lstat(path.join(output, 'specs'));
    assert.equal(specsParent.isDirectory(), true);
    assert.equal(specsParent.isSymbolicLink(), false);
    assert.deepEqual(await fs.readdir(path.join(output, 'specs')), []);
    assert.equal((await fs.lstat(outputs[name].specPath).catch(() => null)), null);
    assert.deepEqual(
      await fs.readFile(path.join(output, 'requirements.md')),
      await fs.readFile(path.join(BENCHMARK, (await readJson(path.join(BENCHMARK, 'benchmark.json'))).cases.find((entry) => entry.id === caseId).sourcePath)),
    );
    assert.equal(run('git', ['status', '--porcelain=v1'], output).stdout, '');
    assert.equal(run('git', ['config', '--local', '--get', 'user.email'], output).stdout.trim(), 'benchmark@sentinel.invalid');
    for (const leaked of ['benchmark.json', 'schemas', 'cases', '.sentinel-benchmark']) {
      assert.equal(await fs.lstat(path.join(output, leaked)).catch(() => null), null);
    }
  }
  assert.equal(outputs['A-one'].contentHash, outputs['A-two'].contentHash);
  const seedAfter = await import(`file://${RUNTIME}`).then((module) => module.contentHash(SEED));
  assert.equal(seedBefore, seedAfter);
  assert.equal(cli(['prepare', '--case', 'A', '--output', path.join(ROOT, 'benchmarks', 'forbidden-workspace')]).status, 2);
  assert.equal(await fs.lstat(path.join(ROOT, 'benchmarks', 'forbidden-workspace')).catch(() => null), null);
  assert.equal(cli(['prepare', '--case', 'A', '--output', path.join(root, 'A-one')]).status, 2);
});

test('B05 — journal persists actual dispatches, optional telemetry, children, and budget aborts', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark journal');
  const journal = path.join(root, 'journal.json');
  await initJournal(journal);
  assert.equal(cli([
    'journal-init', '--output', path.join(root, 'wrong-sha.json'), '--case', 'A',
    '--sentinel-sha', '0'.repeat(40), '--run-mode', 'case', '--production-profile', 'production-v1',
  ]).status, 1);
  requireSuccess(event(journal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high', 'PASS', [
    '--input-tokens', '10', '--output-tokens', '5', '--child-role', 'spec-context-scout',
    '--child-model', 'GPT-5.6-Luna', '--child-effort', 'medium',
  ]), 'journal event with child');
  const invalid = event(journal, 'PLAN', 'PLAN', 'Unknown', 'high');
  assert.equal(invalid.status, 2);
  const persisted = await readJson(journal);
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].model, 'GPT-5.6-Terra');
  assert.equal(persisted.events[0].inputTokens, 10);
  assert.deepEqual(persisted.events[0].childDispatches[0], {
    role: 'spec-context-scout', model: 'GPT-5.6-Luna', effort: 'medium',
  });

  const mappingJournal = path.join(root, 'mapping.json');
  await initJournal(mappingJournal);
  requireSuccess(event(mappingJournal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high'), 'mapped SPEC_INIT');
  assert.equal(event(mappingJournal, 'SPEC_INIT', 'REVIEW_VALIDATE', 'GPT-5.6-Terra', 'high').status, 2);
  requireSuccess(event(mappingJournal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'mapped SPEC_READINESS');
  assert.equal(event(mappingJournal, 'SPEC_READINESS', 'SPEC', 'GPT-5.6-Luna', 'high').status, 2);
  requireSuccess(event(mappingJournal, 'SPEC_CLOSE', 'SPEC', 'GPT-5.6-Terra', 'high'), 'mapped SPEC_CLOSE');
  assert.equal(event(mappingJournal, 'SPEC_CLOSE', 'REVIEW_VALIDATE', 'GPT-5.6-Terra', 'high').status, 2);

  const budgetJournal = path.join(root, 'budget.json');
  await initJournal(budgetJournal);
  requireSuccess(event(budgetJournal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'review 1');
  requireSuccess(event(budgetJournal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'review 2');
  assert.equal(event(budgetJournal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high').status, 3);
  const aborted = await readJson(budgetJournal);
  assert.equal(aborted.status, 'ABORTED_BUDGET');
  assert.equal(aborted.abortReason.budget, 'maxReviewPlanEvents');
  assert.equal(aborted.events.length, 3);
  assert.equal(event(budgetJournal, 'PLAN', 'PLAN', 'GPT-5.6-Terra', 'high').status, 3);
});

test('B06 — finalize collects raw facts and enforces COMPLETE, CLOSED, and final tests', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark finalize');
  const workspace = path.join(root, 'workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', workspace]), 'prepare finalization workspace');
  const spec = await writeSyntheticArtifacts(workspace);
  const journal = path.join(root, 'journal.json');
  await initJournal(journal);
  await completeJournal(journal, { mismatch: true });
  const output = path.join(root, 'result.json');
  requireSuccess(cli(['finalize', '--workspace', workspace, '--case', 'A', '--spec', spec, '--journal', journal, '--output', output]), 'finalize');
  const result = await readJson(output);
  assert.equal(result.status, 'PASS');
  assert.equal(result.decomposition.slices, 1);
  assert.equal(result.decomposition.tasks, 2);
  assert.deepEqual(result.decomposition.tasksPerSlice, { 'slice-01': 2 });
  assert.equal(result.operations.total, 9);
  assert.equal(result.operations.executeCalls, 1);
  assert.equal(result.operations.validateCalls, 1);
  assert.deepEqual(result.modelUse.profileMismatches.map((entry) => entry.operation), ['PLAN']);
  assert.deepEqual(result.modelUse.actualModelsByPhase.SPEC, ['GPT-5.6-Terra']);
  assert.deepEqual(result.modelUse.actualModelsByPhase.REVIEW_VALIDATE, ['GPT-5.6-Luna']);
  assert.equal(result.finalExecutionState, 'COMPLETE');
  assert.equal(result.specClosed, true);
  assert.equal(result.finalTestsPassed, true);
  assert.equal(result.contextCost.actualTokenTelemetryAvailable, false);
  assert.equal(result.contextCost.inputTokens, null);
  assert.ok(result.contextCost.planBytes > 0 && result.contextCost.tasksWords > 0);

  const alignedJournal = path.join(root, 'aligned-journal.json');
  await initJournal(alignedJournal);
  await completeJournal(alignedJournal);
  const alignedOutput = path.join(root, 'aligned-result.json');
  requireSuccess(cli([
    'finalize', '--workspace', workspace, '--case', 'A', '--spec', spec,
    '--journal', alignedJournal, '--output', alignedOutput,
  ]), 'finalize aligned profile');
  assert.deepEqual((await readJson(alignedOutput)).modelUse.profileMismatches, []);

  const missingComplete = path.join(root, 'missing-complete.json');
  await initJournal(missingComplete);
  await completeJournal(missingComplete, { includeComplete: false });
  const incompleteOutput = path.join(root, 'incomplete-result.json');
  assert.equal(cli(['finalize', '--workspace', workspace, '--case', 'A', '--spec', spec, '--journal', missingComplete, '--output', incompleteOutput]).status, 1);
  assert.equal((await readJson(incompleteOutput)).status, 'FAIL');

  const regressedJournal = path.join(root, 'regressed-journal.json');
  await initJournal(regressedJournal);
  await completeJournal(regressedJournal, { regressAfterComplete: true });
  const regressedOutput = path.join(root, 'regressed-result.json');
  assert.equal(cli(['finalize', '--workspace', workspace, '--case', 'A', '--spec', spec, '--journal', regressedJournal, '--output', regressedOutput]).status, 1);
  assert.equal((await readJson(regressedOutput)).finalExecutionState, 'NEEDS_FIX');

  const wrongShaJournal = path.join(root, 'wrong-sha-journal.json');
  await fs.copyFile(journal, wrongShaJournal);
  const tamperedJournal = await readJson(wrongShaJournal);
  tamperedJournal.sentinelSha = '0'.repeat(40);
  await fs.writeFile(wrongShaJournal, `${JSON.stringify(tamperedJournal, null, 2)}\n`, 'utf8');
  const wrongShaOutput = path.join(root, 'wrong-sha-result.json');
  assert.equal(cli(['finalize', '--workspace', workspace, '--case', 'A', '--spec', spec, '--journal', wrongShaJournal, '--output', wrongShaOutput]).status, 1);
  assert.equal((await readJson(wrongShaOutput)).workspace.sentinelShaMatchesCheckout, false);

  await fs.appendFile(path.join(workspace, 'requirements.md'), '\nAltered requirement.\n', 'utf8');
  const alteredOutput = path.join(root, 'altered-requirements-result.json');
  assert.equal(cli(['finalize', '--workspace', workspace, '--case', 'A', '--spec', spec, '--journal', journal, '--output', alteredOutput]).status, 1);
  assert.equal((await readJson(alteredOutput)).workspace.requirementsHashMatches, false);

  const invalidWorkspace = path.join(root, 'invalid-closed-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', invalidWorkspace]), 'prepare invalid closed workspace');
  const invalidSpec = await writeSyntheticArtifacts(invalidWorkspace, 'A', { invalidClosed: true });
  const invalidJournal = path.join(root, 'invalid-closed-journal.json');
  await initJournal(invalidJournal);
  await completeJournal(invalidJournal);
  const invalidOutput = path.join(root, 'invalid-closed-result.json');
  assert.equal(cli(['finalize', '--workspace', invalidWorkspace, '--case', 'A', '--spec', invalidSpec, '--journal', invalidJournal, '--output', invalidOutput]).status, 1);
  assert.equal((await readJson(invalidOutput)).specClosed, false);

  const pathTrapParent = path.join(root, 'status=closed');
  await fs.mkdir(pathTrapParent);
  const readyWorkspace = path.join(pathTrapParent, 'ready-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', readyWorkspace]), 'prepare ready path-trap workspace');
  const readySpec = await writeSyntheticArtifacts(readyWorkspace, 'A', { closed: false });
  const readyJournal = path.join(root, 'ready-journal.json');
  await initJournal(readyJournal);
  await completeJournal(readyJournal);
  const readyOutput = path.join(root, 'ready-result.json');
  assert.equal(cli(['finalize', '--workspace', readyWorkspace, '--case', 'A', '--spec', readySpec, '--journal', readyJournal, '--output', readyOutput]).status, 1);
  assert.equal((await readJson(readyOutput)).specClosed, false);
});

function syntheticResult(caseId, offset, telemetry) {
  const expectedProfile = Object.fromEntries(PHASES.map((phase) => [phase, { model: 'GPT-5.6-Terra', effort: 'high' }]));
  const actualModelsByPhase = Object.fromEntries(PHASES.map((phase) => [phase, [offset === 0 ? 'GPT-5.6-Terra' : 'GPT-5.6-Luna']]));
  const actualEffortsByPhase = Object.fromEntries(PHASES.map((phase) => [phase, [offset === 0 ? 'high' : 'xhigh']]));
  return {
    schemaVersion: 1,
    benchmarkVersion: 1,
    benchmarkId: 'sentinel-todo',
    caseId,
    runMode: 'case',
    sentinelSha: SHA,
    productionProfileId: 'production-v1',
    status: 'PASS',
    finalExecutionState: 'COMPLETE',
    specClosed: true,
    finalTestsPassed: true,
    decomposition: { slices: 1 + offset, tasks: 2 + offset, tasksPerSlice: { 'slice-01': 2 + offset } },
    operations: {
      total: 8 + offset, reviewPlanRounds: 1 + offset, reviewTasksRounds: 1,
      replans: offset, executeCalls: 1 + offset, validateCalls: 1 + offset,
      applyFindingsCalls: offset, findingsCycles: offset, mechanicalRejections: offset, retries: offset,
    },
    modelUse: {
      expectedProfile, actualModelsByPhase, actualEffortsByPhase, childDispatches: [],
      profileMismatches: offset === 0 ? [] : [{
        eventIndex: 1,
        operation: 'PLAN',
        phase: 'PLAN',
        expectedModel: 'GPT-5.6-Terra',
        actualModel: 'GPT-5.6-Luna',
        expectedEffort: 'high',
        actualEffort: 'xhigh',
      }],
      solEscalations: 0,
    },
    contextCost: {
      planBytes: 100 + offset, planWords: 20 + offset, tasksBytes: 80 + offset,
      tasksWords: 15 + offset, handoffBytes: null, observableReads: null,
      actualTokenTelemetryAvailable: telemetry,
      inputTokens: telemetry ? 10 + offset : null,
      outputTokens: telemetry ? 5 + offset : null,
    },
    workspace: {
      changedFileCount: 3 + offset,
      finalDiffBytes: 200 + offset,
      seedContentHash: `sha256:${'a'.repeat(64)}`,
      requirementsHash: `sha256:${'b'.repeat(64)}`,
      requirementsHashMatches: true,
      observedSentinelSha: SHA,
      sentinelShaMatchesCheckout: true,
    },
    finalTests: { command: 'node --test', exitCode: 0, passed: true },
  };
}

test('B07 — compare reports deltas and dispatch changes without fabricated telemetry', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark compare');
  const beforePath = path.join(root, 'before.json');
  const afterPath = path.join(root, 'after.json');
  await fs.writeFile(beforePath, `${JSON.stringify(syntheticResult('A', 0, false), null, 2)}\n`, 'utf8');
  await fs.writeFile(afterPath, `${JSON.stringify(syntheticResult('A', 1, false), null, 2)}\n`, 'utf8');
  const compared = requireSuccess(cli(['compare', '--before', beforePath, '--after', afterPath]), 'compare');
  assert.match(compared.stdout, /\| slices \| 1 \| 2 \| 1 \|/u);
  assert.match(compared.stdout, /GPT-5\.6-Terra \/ high/u);
  assert.match(compared.stdout, /GPT-5\.6-Luna \/ xhigh/u);
  assert.doesNotMatch(compared.stdout, /inputTokens|outputTokens/iu);
  assert.doesNotMatch(compared.stdout, /score|winner/iu);
  const mismatchPath = path.join(root, 'other-case.json');
  await fs.writeFile(mismatchPath, `${JSON.stringify(syntheticResult('B', 1, true), null, 2)}\n`, 'utf8');
  assert.equal(cli(['compare', '--before', beforePath, '--after', mismatchPath]).status, 1);

  for (const [name, mutate, diagnosis] of [
    ['requirements', (result) => { result.workspace.requirementsHash = `sha256:${'c'.repeat(64)}`; }, /requirements hash/u],
    ['seed', (result) => { result.workspace.seedContentHash = `sha256:${'c'.repeat(64)}`; }, /seed content hash/u],
    ['profile', (result) => { result.productionProfileId = 'production-v2'; }, /production profile/u],
  ]) {
    const incompatible = syntheticResult('A', 1, false);
    mutate(incompatible);
    const incompatiblePath = path.join(root, `${name}-mismatch.json`);
    await fs.writeFile(incompatiblePath, `${JSON.stringify(incompatible, null, 2)}\n`, 'utf8');
    const rejected = cli(['compare', '--before', beforePath, '--after', incompatiblePath]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, diagnosis);
  }
});
