#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeRequirementsAuthority } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'sentinel-todo');
const RUNTIME = path.join(BENCHMARK, 'runtime', 'benchmark.mjs');
const ENVIRONMENT_RUNTIME = path.join(BENCHMARK, 'runtime', 'benchmark-environment.mjs');
const SEED = path.join(BENCHMARK, 'seed');
const CLOSED_SPEC_FIXTURE = path.join(
  ROOT, 'skills', 'workflows', 'stnl-spec-lifecycle-manager',
  'examples', 'validator-fixtures', 'closed', 'feature_spec.md',
);
const READY_SPEC_FIXTURE = path.join(
  ROOT, 'skills', 'workflows', 'stnl-spec-lifecycle-manager',
  'examples', 'validator-fixtures', 'ready',
);
const PLAN_TEMPLATE = path.join(ROOT, 'skills', 'workflows', 'stnl-execution-planner', 'templates', 'plan.template.md');
const SLICE_PLAN_TEMPLATE = path.join(ROOT, 'skills', 'workflows', 'stnl-execution-planner', 'templates', 'slice-plan.template.md');
const TASKS_TEMPLATE = path.join(ROOT, 'skills', 'workflows', 'stnl-task-materializer', 'templates', 'tasks.template.md');
const SLICE_TASKS_TEMPLATE = path.join(ROOT, 'skills', 'workflows', 'stnl-task-materializer', 'templates', 'slice-tasks.template.md');
const SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', shell: false }).stdout.trim();
const PHASES = ['SPEC', 'PLAN', 'TASKS', 'EXECUTE', 'REVIEW_VALIDATE'];
const CURRENT_PROFILE = 'production-v2';
const VALIDATED_CONTENT = 'validated behavior\n';
const VALIDATED_HASH = createHash('sha256').update(VALIDATED_CONTENT).digest('hex');

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
    '--run-mode', runMode, '--production-profile', CURRENT_PROFILE,
  ]), 'journal-init');
}

function replaceAll(text, values) {
  let result = text;
  for (const [from, to] of values) result = result.replaceAll(from, to);
  return result;
}

function replaceSection(text, heading, content) {
  const pattern = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u');
  assert.match(text, pattern);
  return text.replace(pattern, `$1${content}\n`);
}

function readyPlan(text) {
  return text.replace('status: draft', 'status: ready').replaceAll('Review state: pending', 'Review state: approved');
}

function omitInitialRecoveryFields(text) {
  return text.replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, '\n## Serial Slice Order');
}

async function writeCanonicalExecution(workspace, spec, { terminal = true } = {}) {
  const execution = path.join(spec, 'execution');
  const plans = path.join(execution, 'plans');
  const tasks = path.join(execution, 'tasks');
  await fs.mkdir(plans, { recursive: true });
  await fs.mkdir(tasks, { recursive: true });

  const authority = await computeRequirementsAuthority(spec);
  const authorityPath = path.join(spec, 'feature_spec.md');
  const implementationTarget = path.join(workspace, 'src', 'example.txt');
  const globalSource = path.relative(execution, authorityPath).split(path.sep).join('/');
  const detailSource = path.relative(plans, authorityPath).split(path.sep).join('/');
  const taskSource = path.relative(tasks, authorityPath).split(path.sep).join('/');
  const globalImplementation = path.relative(execution, implementationTarget).split(path.sep).join('/');
  const detailImplementation = path.relative(plans, implementationTarget).split(path.sep).join('/');
  const taskImplementation = path.relative(tasks, implementationTarget).split(path.sep).join('/');

  const planTemplate = await fs.readFile(PLAN_TEMPLATE, 'utf8');
  const globalPlan = readyPlan(omitInitialRecoveryFields(replaceAll(planTemplate, [
    ['`<relative path>`', `\`${globalSource}\``], ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'], ['<compact objective>', 'Deliver observable behavior'],
    ['<compact strategy>', 'Implement and validate serially'], ['01 - <name>', '01 - Delivery'],
    ['<result>', 'observable result'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${globalImplementation}\`; example implementation`],
  ])));
  await fs.writeFile(path.join(execution, 'plan.md'), globalPlan, 'utf8');

  const slicePlanTemplate = await fs.readFile(SLICE_PLAN_TEMPLATE, 'utf8');
  const slicePlan = readyPlan(replaceAll(slicePlanTemplate, [
    ['<Name>', 'Delivery'], ['`<relative path>`', `\`${detailSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '1'],
    ['<One coherent delivery and how it is observed.>', 'Deliver observable behavior.'],
    ['<included work>', 'Implement the approved behavior.'],
    ['<excluded work and boundary with later slices>', 'No unrelated work.'],
    ['`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>', `\`${detailImplementation}\` — example implementation`],
    ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Low risk; focused validation.'],
    ['<bounded approach>', 'One bounded change.'], ['<test, command, suite, or observable check>', 'node --test'],
    ['<objective result and preserved boundary>', 'Behavior is observable and bounded.'],
  ]));
  await fs.writeFile(path.join(plans, 'slice-01.md'), slicePlan, 'utf8');

  const tasksTemplate = await fs.readFile(TASKS_TEMPLATE, 'utf8');
  let tasksIndex = replaceAll(tasksTemplate, [
    ['01 - <name>', '01 - Delivery'], ['<observable delivery>', 'observable result'],
  ]);
  const sliceTasksTemplate = await fs.readFile(SLICE_TASKS_TEMPLATE, 'utf8');
  let task = replaceAll(sliceTasksTemplate, [
    ['<Name>', 'Delivery'], ['`<relative path>`', `\`${taskSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '1'],
    ['<task>', 'Implement behavior'], ['<result>', 'observable result'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${taskImplementation}\`; example implementation`],
    ['<test, command, suite, or observable check>', 'node --test'],
  ]);

  if (terminal) {
    await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
    await fs.writeFile(implementationTarget, VALIDATED_CONTENT, 'utf8');
    task = task.replace('- [ ] 1.1', '- [x] 1.1');
    task = replaceSection(task, 'Changed Areas', `- \`${taskImplementation}\``);
    task = replaceSection(task, 'Validation Attempts', `### attempt-01

- Type: initial
- Status: PASS
- HEAD: fixture
- Verified scope: ${taskImplementation}
- Commands:
  - \`node --test\` | exit:0
- Evidence: Objective PASS evidence.
- Finding references: none
- Finding dispositions: none
- Blockers: none
- Unexpected workspace effects: none
- Persistence summary: PASS persisted.`);
    task = replaceSection(task, 'Effective Validation Base', `- Origin attempt: attempt-01
- Attempt type: initial
- HEAD: fixture
- Result: PASS
- Files:
  - \`${taskImplementation}\` | sha256:${VALIDATED_HASH}
- Authoritative commands:
  - \`node --test\` | exit:0
- Evidence summary: Objective PASS evidence.`);
    task = replaceSection(task, 'Diff Summary', '- Implemented and validated the observable behavior.');
    task = replaceSection(task, 'Final Result', '- PASS');
    tasksIndex = tasksIndex.replace(
      '| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |',
      '| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |',
    );
  }

  await fs.writeFile(path.join(execution, 'tasks.md'), tasksIndex, 'utf8');
  await fs.writeFile(path.join(tasks, 'slice-01.md'), task, 'utf8');
  return { implementationTarget, taskImplementation };
}

async function writeSyntheticArtifacts(workspace, caseId = 'A', { closed = true, invalidClosed = false, terminal = true } = {}) {
  const spec = path.join(workspace, 'specs', `benchmark-case-${caseId.toLowerCase()}`);
  await fs.mkdir(spec, { recursive: true });
  if (closed) await fs.copyFile(CLOSED_SPEC_FIXTURE, path.join(spec, 'feature_spec.md'));
  else if (!closed) {
    await fs.copyFile(path.join(READY_SPEC_FIXTURE, 'feature_spec.md'), path.join(spec, 'feature_spec.md'));
    await fs.cp(path.join(READY_SPEC_FIXTURE, 'shared'), path.join(spec, 'shared'), { recursive: true });
  }
  const execution = await writeCanonicalExecution(workspace, spec, { terminal });
  if (invalidClosed) {
    const featureSpec = path.join(spec, 'feature_spec.md');
    await fs.writeFile(featureSpec, (await fs.readFile(featureSpec, 'utf8')).replace('status: closed', 'status: invalid'), 'utf8');
  }
  return { spec, ...execution };
}

async function completeJournal(file, {
  mismatch = false,
  specModel = 'GPT-5.6-Sol',
  specCloseModel = specModel,
  includeInitialReadiness = true,
  includeTerminalReadiness = true,
  initialReadinessState = 'GLOBAL_READY',
  includeComplete = true,
  regressAfterComplete = false,
  lateReadiness = false,
  recoveredBlocked = false,
  extraAfterClose = false,
  multipleClose = false,
} = {}) {
  requireSuccess(event(file, 'SPEC_INIT', 'SPEC', specModel, 'high'), 'SPEC_INIT');
  if (includeInitialReadiness) {
    const readinessExtra = initialReadinessState === null ? [] : ['--resulting-state', initialReadinessState];
    requireSuccess(event(file, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', readinessExtra), 'SPEC_READINESS');
  }
  requireSuccess(event(file, 'PLAN', 'PLAN', mismatch ? 'GPT-5.6-Sol' : 'GPT-5.6-Terra', mismatch ? 'xhigh' : 'high'), 'PLAN');
  requireSuccess(event(file, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'REVIEW_PLAN');
  requireSuccess(event(file, 'MATERIALIZE_TASKS', 'TASKS', 'GPT-5.6-Terra', 'high'), 'MATERIALIZE_TASKS');
  requireSuccess(event(file, 'REVIEW_TASKS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'REVIEW_TASKS');
  if (recoveredBlocked) {
    requireSuccess(event(file, 'EXECUTE_SLICE', 'EXECUTE', 'GPT-5.6-Luna', 'high', 'BLOCKED', ['--slice', 'slice-01']), 'blocked EXECUTE_SLICE');
  }
  requireSuccess(event(file, 'EXECUTE_SLICE', 'EXECUTE', 'GPT-5.6-Luna', 'high', 'PASS', ['--slice', 'slice-01']), 'EXECUTE_SLICE');
  const validateExtra = ['--slice', 'slice-01'];
  if (includeComplete) validateExtra.push('--resulting-state', 'COMPLETE');
  requireSuccess(event(file, 'VALIDATE_SLICE', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', validateExtra), 'VALIDATE_SLICE');
  if (regressAfterComplete) {
    requireSuccess(event(file, 'VALIDATE_SLICE', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'NEEDS_FIX', [
      '--slice', 'slice-01', '--round', '2', '--resulting-state', 'NEEDS_FIX',
    ]), 'regressed VALIDATE_SLICE');
  }
  if (includeTerminalReadiness) {
    requireSuccess(event(file, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS',
      ['--resulting-state', 'GLOBAL_READY']), 'terminal SPEC_READINESS');
  }
  if (lateReadiness) {
    requireSuccess(event(file, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'late SPEC_READINESS');
  }
  requireSuccess(event(file, 'SPEC_CLOSE', 'SPEC', specCloseModel, 'high', 'PASS', ['--resulting-state', 'SPEC_CLOSED']), 'SPEC_CLOSE');
  if (multipleClose) {
    requireSuccess(event(file, 'SPEC_CLOSE', 'SPEC', 'GPT-5.6-Terra', 'high', 'PASS', ['--resulting-state', 'SPEC_CLOSED']), 'duplicate SPEC_CLOSE');
  }
  if (extraAfterClose) {
    requireSuccess(event(file, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'post-close SPEC_READINESS');
  }
}

test('B01 — manifest has bounded cases, profiles, paths, and schemas', async () => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  assert.equal(configuration.benchmarkId, 'sentinel-todo');
  assert.equal(configuration.benchmarkVersion, 1);
  assert.equal(configuration.productionProfile.id, CURRENT_PROFILE);
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

test('B09 — production profile v2 is current and dispatch enforcement is deterministic', async (t) => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  assert.equal(configuration.productionProfile.id, 'production-v2');
  for (const relative of ['schemas/journal.schema.json', 'schemas/result.schema.json']) {
    const schema = await readJson(path.join(BENCHMARK, relative));
    assert.deepEqual(schema.properties.productionProfileId.enum, ['production-v1', 'production-v2']);
  }
  assert.deepEqual(configuration.productionProfile.cases.A, {
    SPEC: { model: 'GPT-5.6-Sol', effort: 'high' },
    PLAN: { model: 'GPT-5.6-Terra', effort: 'high' },
    TASKS: { model: 'GPT-5.6-Terra', effort: 'high' },
    EXECUTE: { model: 'GPT-5.6-Luna', effort: 'high' },
    REVIEW_VALIDATE: { model: 'GPT-5.6-Luna', effort: 'high' },
  });
  assert.deepEqual(configuration.productionProfile.cases.B, {
    SPEC: { model: 'GPT-5.6-Terra', effort: 'high' },
    PLAN: { model: 'GPT-5.6-Terra', effort: 'high' },
    TASKS: { model: 'GPT-5.6-Terra', effort: 'high' },
    EXECUTE: { model: 'GPT-5.6-Luna', effort: 'xhigh' },
    REVIEW_VALIDATE: { model: 'GPT-5.6-Luna', effort: 'xhigh' },
  });
  assert.deepEqual(configuration.productionProfile.cases.C, {
    SPEC: { model: 'GPT-5.6-Sol', effort: 'high' },
    PLAN: { model: 'GPT-5.6-Sol', effort: 'high' },
    TASKS: { model: 'GPT-5.6-Terra', effort: 'high' },
    EXECUTE: { model: 'GPT-5.6-Luna', effort: 'xhigh' },
    REVIEW_VALIDATE: { model: 'GPT-5.6-Luna', effort: 'xhigh' },
  });
  assert.deepEqual(configuration.cases.map(({ id, budgets }) => ({ id, budgets })), [
    { id: 'A', budgets: { maxReviewPlanEvents: 2, maxReviewTasksEvents: 2, maxReplans: 1, maxExecuteSliceAttemptsPerSlice: 3, maxApplyFindingsPerSlice: 2, maxWorkflowEvents: 14 } },
    { id: 'B', budgets: { maxReviewPlanEvents: 2, maxReviewTasksEvents: 2, maxReplans: 1, maxExecuteSliceAttemptsPerSlice: 3, maxApplyFindingsPerSlice: 2, maxWorkflowEvents: 20 } },
    { id: 'C', budgets: { maxReviewPlanEvents: 2, maxReviewTasksEvents: 2, maxReplans: 1, maxExecuteSliceAttemptsPerSlice: 3, maxApplyFindingsPerSlice: 2, maxWorkflowEvents: 24 } },
  ]);
  assert.deepEqual(configuration.cases.map(({ id, requirementsHash, fixtureContentHash }) => ({ id, requirementsHash, fixtureContentHash })), [
    { id: 'A', requirementsHash: 'sha256:e5934bc22267756c3c10b31c46b7a9cd894b78e961b11975b0f14f7085349a24', fixtureContentHash: 'sha256:e0c3233c14356e93accff61b334704a91fb8e4f82a60209768259144d88a10d5' },
    { id: 'B', requirementsHash: 'sha256:0388a84f8c5a9c45fcd5b1d0b59e7d376979e98717d8e028067701f00a16fc57', fixtureContentHash: 'sha256:107d1057e48506a20da4460ee33febca26280dd35c85f645b0de6b81ffb33e10' },
    { id: 'C', requirementsHash: 'sha256:a896026d591f06776ade1d88fde292c4e5f0d015e5e18374e9cf754ecce4efcb', fixtureContentHash: 'sha256:a9700e1844ce7106809491f924b0fea37d8bf15700afa14c920cc1ee139fdd44' },
  ]);
  assert.equal(configuration.integrity.seedContentHash, 'sha256:9d93fbfa52b2e20607452f43d0ecb21e74f1872bb7a2da1b94dc2c814e7552e8');

  const root = await temporaryRoot(t, 'sentinel production profile v2');
  const workspace = path.join(root, 'workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', workspace]), 'prepare profile fixture');
  const { spec } = await writeSyntheticArtifacts(workspace);
  const finalize = (journal, output) => cli([
    'finalize', '--workspace', workspace, '--case', 'A', '--spec', spec,
    '--journal', journal, '--output', output,
  ]);
  const alignedJournal = path.join(root, 'aligned-journal.json');
  await initJournal(alignedJournal);
  await completeJournal(alignedJournal);
  const alignedOutput = path.join(root, 'aligned-result.json');
  requireSuccess(finalize(alignedJournal, alignedOutput), 'finalize Sol/high profile fixture');
  const alignedResult = await readJson(alignedOutput);
  assert.equal(alignedResult.productionProfileId, 'production-v2');
  assert.deepEqual(alignedResult.modelUse.profileMismatches, []);

  const terraJournal = path.join(root, 'terra-journal.json');
  await initJournal(terraJournal);
  await completeJournal(terraJournal, { specModel: 'GPT-5.6-Terra', specCloseModel: 'GPT-5.6-Sol' });
  const terraOutput = path.join(root, 'terra-result.json');
  requireSuccess(finalize(terraJournal, terraOutput), 'finalize Terra/high mismatch fixture');
  const terraResult = await readJson(terraOutput);
  assert.deepEqual(terraResult.modelUse.profileMismatches.map((entry) => [entry.phase, entry.expectedModel, entry.actualModel]), [
    ['SPEC', 'GPT-5.6-Sol', 'GPT-5.6-Terra'],
  ]);
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
    '--sentinel-sha', '0'.repeat(40), '--run-mode', 'case', '--production-profile', CURRENT_PROFILE,
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

test('B06 — finalize collects raw facts and enforces official terminal semantics', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark finalize');
  const workspace = path.join(root, 'workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', workspace]), 'prepare finalization workspace');
  const { spec } = await writeSyntheticArtifacts(workspace);
  const finalize = (journal, output, selectedWorkspace = workspace, selectedSpec = spec) => cli([
    'finalize', '--workspace', selectedWorkspace, '--case', 'A', '--spec', selectedSpec,
    '--journal', journal, '--output', output,
  ]);

  const journal = path.join(root, 'journal.json');
  await initJournal(journal);
  await completeJournal(journal, { mismatch: true });
  const output = path.join(root, 'result.json');
  requireSuccess(finalize(journal, output), 'finalize');
  const result = await readJson(output);
  assert.equal(result.status, 'PASS');
  assert.equal(result.decomposition.slices, 1);
  assert.equal(result.decomposition.tasks, 1);
  assert.deepEqual(result.decomposition.tasksPerSlice, { 'slice-01': 1 });
  assert.equal(result.operations.total, 10);
  assert.deepEqual((await readJson(journal)).events.slice(0, 3).map((entry) => entry.operation), [
    'SPEC_INIT', 'SPEC_READINESS', 'PLAN',
  ]);
  assert.equal(result.operations.executeCalls, 1);
  assert.equal(result.operations.validateCalls, 1);
  assert.deepEqual(result.modelUse.profileMismatches.map((entry) => entry.operation), ['PLAN']);
  assert.deepEqual(result.modelUse.actualModelsByPhase.SPEC, ['GPT-5.6-Sol']);
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
  requireSuccess(finalize(alignedJournal, alignedOutput), 'finalize aligned profile');
  assert.deepEqual((await readJson(alignedOutput)).modelUse.profileMismatches, []);

  const recoveredJournal = path.join(root, 'recovered-blocked.json');
  await initJournal(recoveredJournal);
  await completeJournal(recoveredJournal, { recoveredBlocked: true });
  const recoveredOutput = path.join(root, 'recovered-blocked-result.json');
  requireSuccess(finalize(recoveredJournal, recoveredOutput), 'finalize recovered BLOCKED');
  const recoveredResult = await readJson(recoveredOutput);
  assert.equal(recoveredResult.status, 'PASS');
  assert.equal(recoveredResult.operations.executeCalls, 2);
  assert.equal((await readJson(recoveredJournal)).events.some((item) => item.result === 'BLOCKED'), true);

  const unrecoveredJournal = path.join(root, 'unrecovered-blocked.json');
  await initJournal(unrecoveredJournal);
  requireSuccess(event(unrecoveredJournal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high'), 'blocked SPEC_INIT');
  requireSuccess(event(unrecoveredJournal, 'EXECUTE_SLICE', 'EXECUTE', 'GPT-5.6-Luna', 'high', 'BLOCKED', [
    '--slice', 'slice-01',
  ]), 'unrecovered EXECUTE_SLICE');
  const unrecoveredOutput = path.join(root, 'unrecovered-blocked-result.json');
  assert.equal(finalize(unrecoveredJournal, unrecoveredOutput).status, 1);
  assert.equal((await readJson(unrecoveredOutput)).status, 'BLOCKED');

  const budgetJournal = path.join(root, 'terminal-looking-budget.json');
  await initJournal(budgetJournal);
  await completeJournal(budgetJournal);
  const budgetDocument = await readJson(budgetJournal);
  const reviewPlan = budgetDocument.events.find((item) => item.operation === 'REVIEW_PLAN');
  budgetDocument.events.splice(reviewPlan.index, 0, { ...reviewPlan, index: 0 }, { ...reviewPlan, index: 0 });
  budgetDocument.events.forEach((item, index) => { item.index = index + 1; });
  budgetDocument.status = 'ABORTED_BUDGET';
  budgetDocument.abortReason = {
    code: 'BUDGET_EXCEEDED', budget: 'maxReviewPlanEvents', limit: 2, observed: 3, eventIndex: reviewPlan.index + 2,
  };
  await fs.writeFile(budgetJournal, `${JSON.stringify(budgetDocument, null, 2)}\n`, 'utf8');
  const budgetOutput = path.join(root, 'terminal-looking-budget-result.json');
  assert.equal(finalize(budgetJournal, budgetOutput).status, 1);
  assert.equal((await readJson(budgetOutput)).status, 'ABORTED_BUDGET');

  const missingComplete = path.join(root, 'missing-complete.json');
  await initJournal(missingComplete);
  await completeJournal(missingComplete, { includeComplete: false });
  const incompleteOutput = path.join(root, 'incomplete-result.json');
  assert.equal(finalize(missingComplete, incompleteOutput).status, 1);
  assert.equal((await readJson(incompleteOutput)).status, 'FAIL');

  const missingReadiness = path.join(root, 'missing-readiness.json');
  await initJournal(missingReadiness);
  await completeJournal(missingReadiness, { includeInitialReadiness: false });
  const missingReadinessOutput = path.join(root, 'missing-readiness-result.json');
  assert.equal(finalize(missingReadiness, missingReadinessOutput).status, 1);
  assert.equal((await readJson(missingReadinessOutput)).status, 'FAIL');

  const missingTerminalReadiness = path.join(root, 'missing-terminal-readiness.json');
  await initJournal(missingTerminalReadiness);
  await completeJournal(missingTerminalReadiness, { includeTerminalReadiness: false });
  const missingTerminalReadinessOutput = path.join(root, 'missing-terminal-readiness-result.json');
  assert.equal(finalize(missingTerminalReadiness, missingTerminalReadinessOutput).status, 1);
  assert.equal((await readJson(missingTerminalReadinessOutput)).status, 'FAIL');

  const lateReadiness = path.join(root, 'late-readiness.json');
  await initJournal(lateReadiness);
  await completeJournal(lateReadiness, { includeInitialReadiness: false, lateReadiness: true });
  const lateReadinessOutput = path.join(root, 'late-readiness-result.json');
  assert.equal(finalize(lateReadiness, lateReadinessOutput).status, 1);
  assert.equal((await readJson(lateReadinessOutput)).status, 'FAIL');

  const duplicateReadiness = path.join(root, 'duplicate-readiness.json');
  await initJournal(duplicateReadiness);
  await completeJournal(duplicateReadiness, { lateReadiness: true });
  const duplicateReadinessOutput = path.join(root, 'duplicate-readiness-result.json');
  assert.equal(finalize(duplicateReadiness, duplicateReadinessOutput).status, 1);
  assert.equal((await readJson(duplicateReadinessOutput)).status, 'FAIL');

  for (const [name, initialReadinessState] of [['missing-global-state', null], ['wrong-global-state', 'READY']]) {
    const readinessJournal = path.join(root, `${name}.json`);
    await initJournal(readinessJournal);
    await completeJournal(readinessJournal, { initialReadinessState });
    const readinessOutput = path.join(root, `${name}-result.json`);
    assert.equal(finalize(readinessJournal, readinessOutput).status, 1);
    assert.equal((await readJson(readinessOutput)).status, 'FAIL');
  }

  const regressedJournal = path.join(root, 'regressed-journal.json');
  await initJournal(regressedJournal);
  await completeJournal(regressedJournal, { regressAfterComplete: true });
  const regressedOutput = path.join(root, 'regressed-result.json');
  assert.equal(finalize(regressedJournal, regressedOutput).status, 1);
  const regressedResult = await readJson(regressedOutput);
  assert.equal(regressedResult.status, 'FAIL');
  assert.equal(regressedResult.finalExecutionState, 'COMPLETE');

  const extraAfterClose = path.join(root, 'extra-after-close.json');
  await initJournal(extraAfterClose);
  await completeJournal(extraAfterClose, { extraAfterClose: true });
  const extraAfterCloseOutput = path.join(root, 'extra-after-close-result.json');
  assert.equal(finalize(extraAfterClose, extraAfterCloseOutput).status, 1);
  assert.equal((await readJson(extraAfterCloseOutput)).status, 'FAIL');

  const multipleClose = path.join(root, 'multiple-close.json');
  await initJournal(multipleClose);
  await completeJournal(multipleClose, { multipleClose: true });
  const multipleCloseOutput = path.join(root, 'multiple-close-result.json');
  assert.equal(finalize(multipleClose, multipleCloseOutput).status, 1);
  assert.equal((await readJson(multipleCloseOutput)).status, 'FAIL');

  const incompleteWorkspace = path.join(root, 'non-complete-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', incompleteWorkspace]), 'prepare non-COMPLETE workspace');
  const { spec: incompleteSpec } = await writeSyntheticArtifacts(incompleteWorkspace, 'A', { terminal: false });
  const nonCompleteJournal = path.join(root, 'non-complete-runtime.json');
  await initJournal(nonCompleteJournal);
  await completeJournal(nonCompleteJournal);
  const nonCompleteOutput = path.join(root, 'non-complete-runtime-result.json');
  assert.equal(finalize(nonCompleteJournal, nonCompleteOutput, incompleteWorkspace, incompleteSpec).status, 1);
  const nonCompleteResult = await readJson(nonCompleteOutput);
  assert.equal(nonCompleteResult.status, 'FAIL');
  assert.equal(nonCompleteResult.finalExecutionState, 'MATERIALIZED_PRISTINE');

  const driftWorkspace = path.join(root, 'ownership-drift-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', driftWorkspace]), 'prepare ownership drift workspace');
  const driftFixture = await writeSyntheticArtifacts(driftWorkspace);
  await fs.writeFile(driftFixture.implementationTarget, 'post-PASS drift\n', 'utf8');
  const driftJournal = path.join(root, 'ownership-drift.json');
  await initJournal(driftJournal);
  await completeJournal(driftJournal);
  const driftOutput = path.join(root, 'ownership-drift-result.json');
  assert.equal(finalize(driftJournal, driftOutput, driftWorkspace, driftFixture.spec).status, 1);
  const driftResult = await readJson(driftOutput);
  assert.equal(driftResult.status, 'BLOCKED');
  assert.equal(driftResult.finalExecutionState, null);

  const wrongShaJournal = path.join(root, 'wrong-sha-journal.json');
  await fs.copyFile(journal, wrongShaJournal);
  const tamperedJournal = await readJson(wrongShaJournal);
  tamperedJournal.sentinelSha = '0'.repeat(40);
  await fs.writeFile(wrongShaJournal, `${JSON.stringify(tamperedJournal, null, 2)}\n`, 'utf8');
  const wrongShaOutput = path.join(root, 'wrong-sha-result.json');
  assert.equal(finalize(wrongShaJournal, wrongShaOutput).status, 1);
  assert.equal((await readJson(wrongShaOutput)).workspace.sentinelShaMatchesCheckout, false);

  await fs.appendFile(path.join(workspace, 'requirements.md'), '\nAltered requirement.\n', 'utf8');
  const alteredOutput = path.join(root, 'altered-requirements-result.json');
  assert.equal(finalize(journal, alteredOutput).status, 1);
  assert.equal((await readJson(alteredOutput)).workspace.requirementsHashMatches, false);

  const invalidWorkspace = path.join(root, 'invalid-closed-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', invalidWorkspace]), 'prepare invalid closed workspace');
  const { spec: invalidSpec } = await writeSyntheticArtifacts(invalidWorkspace, 'A', { invalidClosed: true });
  const invalidJournal = path.join(root, 'invalid-closed-journal.json');
  await initJournal(invalidJournal);
  await completeJournal(invalidJournal);
  const invalidOutput = path.join(root, 'invalid-closed-result.json');
  assert.equal(finalize(invalidJournal, invalidOutput, invalidWorkspace, invalidSpec).status, 1);
  assert.equal((await readJson(invalidOutput)).specClosed, false);

  const pathTrapParent = path.join(root, 'status=closed');
  await fs.mkdir(pathTrapParent);
  const readyWorkspace = path.join(pathTrapParent, 'ready-workspace');
  requireSuccess(cli(['prepare', '--case', 'A', '--output', readyWorkspace]), 'prepare ready path-trap workspace');
  const { spec: readySpec } = await writeSyntheticArtifacts(readyWorkspace, 'A', { closed: false });
  const readyJournal = path.join(root, 'ready-journal.json');
  await initJournal(readyJournal);
  await completeJournal(readyJournal);
  const readyOutput = path.join(root, 'ready-result.json');
  assert.equal(finalize(readyJournal, readyOutput, readyWorkspace, readySpec).status, 1);
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

test('B08 — doctor routing is offline and separate from benchmark definitions', async () => {
  const manifestPath = path.join(BENCHMARK, 'benchmark.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  assert.equal(cli(['doctor', '--unknown', 'value']).status, 2);
  assert.equal(cli(['doctor', '--scratch-parent']).status, 2);
  assert.equal(cli(['doctor', '--probe-workspace', ROOT]).status, 2);
  assert.equal(cli(['doctor', '--scratch-parent', path.join(ROOT, 'benchmarks')]).status, 2);

  const runtimeSource = await fs.readFile(RUNTIME, 'utf8');
  const source = await fs.readFile(ENVIRONMENT_RUNTIME, 'utf8');
  assert.match(runtimeSource, /command === 'doctor'/u);
  assert.match(runtimeSource, /runDoctor\(\{/u);
  for (const field of [
    'status', 'contractVersion', 'platform', 'arch', 'nodeVersion', 'gitVersion',
    'checks', 'globalGitConfigPreserved', 'blockers',
  ]) assert.match(source, new RegExp(`\\b${field}\\b`, 'u'));
  assert.match(source, /ENVIRONMENT_READY/u);
  assert.match(source, /ENVIRONMENT_BLOCKED/u);
  assert.doesNotMatch(source, /\b(?:fetch|https?|provider|openai)\b/iu);
  assert.doesNotMatch(source, /benchmark\.json|productionProfile|budgets|cases\//u);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});
