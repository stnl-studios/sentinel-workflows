#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupManagedBenchmarkSession,
  createManagedBenchmarkSession,
} from '../benchmarks/sentinel-todo/runtime/benchmark-environment.mjs';
import {
  applyBlockedStopPolicy,
  createCriticalFixture,
  inspectHarnessWorkspaceGitGeometry,
  inspectFixturePathBasis,
  prepareHarnessWorkspace,
  preparePostR06Fixture,
  runDeterministicStages,
} from '../benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs';
import {
  ExecutionContractError,
  validateExecutionCandidate,
} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

function globalGitFingerprint() {
  const result = spawnSync('git', ['config', '--global', '--list', '--show-origin', '--show-scope', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return createHash('sha256').update(result.stdout).digest('hex');
}

async function temporaryFixture(t, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `stnl-rehearsal-${name}-`)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'r07-isolated');
  await fs.mkdir(workspace, { recursive: true });
  const fixture = await createCriticalFixture(workspace);
  await preparePostR06Fixture(fixture);
  return fixture;
}

test('R01-R05 deterministic rehearsal proves authority, drift, runner contract, BLOCKED stop, and pristine fixture', async () => {
  const report = await runDeterministicStages();
  assert.equal(report.status, 'PRE_PILOT_REHEARSAL_READY');
  assert.deepEqual(report.stages.map((stage) => stage.result), [
    'R01_PASS',
    'R02_PASS',
    'R03_PASS',
    'R04_PASS',
    'R05_PASS',
  ]);
});

test('valid runner BLOCKED is one logical event and never an automatic retry round', () => {
  const result = applyBlockedStopPolicy({
    logicalExecuteEvents: 0,
    implementationChecks: 0,
    state: 'MATERIALIZED_PRISTINE',
    caseTerminal: false,
    automaticRounds: 0,
    automaticReentry: false,
  }, { status: 'BLOCKED', round: 1 });
  assert.deepEqual(result, {
    logicalExecuteEvents: 1,
    implementationChecks: 1,
    state: 'AUXILIARY_BLOCKED',
    caseTerminal: true,
    automaticRounds: 0,
    automaticReentry: false,
  });
});

test('TESTS_FAIL before round 3 remains the only automatic correction-and-recheck path', () => {
  const result = applyBlockedStopPolicy({
    logicalExecuteEvents: 0,
    implementationChecks: 0,
    state: 'MATERIALIZED_PRISTINE',
    caseTerminal: false,
    automaticRounds: 0,
    automaticReentry: false,
  }, { status: 'TESTS_FAIL', round: 1 });
  assert.equal(result.caseTerminal, false);
  assert.equal(result.automaticRounds, 1);
  assert.equal(result.automaticReentry, true);
});

test('POST-R06 fixture derives every implementation path from its canonical artifact basis', async (t) => {
  const fixture = await temporaryFixture(t, 'path-valid');
  const gate = await inspectFixturePathBasis({ workspace: fixture.workspace, spec: fixture.spec });
  assert.equal(gate.status, 'FIXTURE_PATH_BASIS_PASS');
  assert.equal(gate.rows.length, 5);
  assert.equal(gate.rows.every((row) => row.result === 'PASS'), true);
  assert.equal(gate.rows.every((row) => row.exists && row.inWorkspace && row.outsideSpec && row.expectedTargetMatches), true);
  assert.equal(gate.rows.find((row) => row.label === 'Implementation tested state')?.hash, 'PASS');
});

test('critical fixture plans and tests cover the complete expired-invitation contract', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-rehearsal-semantic-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const fixture = await createCriticalFixture(workspace);
  const [globalPlan, slicePlan, task, focusedTest, publicContract] = await Promise.all([
    fs.readFile(path.join(fixture.spec, 'execution/plan.md'), 'utf8'),
    fs.readFile(path.join(fixture.spec, 'execution/plans/slice-01.md'), 'utf8'),
    fs.readFile(path.join(fixture.spec, 'execution/tasks/slice-01.md'), 'utf8'),
    fs.readFile(path.join(workspace, 'test/invitation.test.mjs'), 'utf8'),
    fs.readFile(path.join(workspace, 'docs/core/CONTRACTS.md'), 'utf8'),
  ]);
  for (const artifact of [globalPlan, slicePlan, task]) {
    assert.match(artifact, /expired invitation|expired-invitation/iu);
    assert.match(artifact, /envelope/iu);
    assert.match(artifact, /participation/iu);
  }
  assert.match(focusedTest, /status: 410/u);
  assert.match(focusedTest, /INVITATION_EXPIRED/u);
  assert.match(focusedTest, /assert\.deepEqual\(participations, \[\]\)/u);
  assert.match(publicContract, /HTTP 410/u);
  assert.match(publicContract, /creates no participation/u);
});

test('EXECUTE candidate validation rejects wrong task basis or hash before live publication', async (t) => {
  const fixture = await temporaryFixture(t, 'candidate-path-basis');
  const liveTask = path.join(fixture.spec, 'execution/tasks/slice-01.md');
  const liveBefore = await fs.readFile(liveTask);
  const canonical = fixture.paths.taskImplementation;
  const cases = [
    {
      name: 'changed-areas-basis',
      mutate: (text) => text.replace(`## Changed Areas\n\n- \`${canonical}\``, '## Changed Areas\n\n- `src/invitation.mjs`'),
      expected: /Changed Areas|file-backed candidate evidence/u,
    },
    {
      name: 'tested-state-basis',
      mutate: (text) => text.replace(`  - \`${canonical}\` | sha256:`, '  - `src/invitation.mjs` | sha256:'),
      expected: /Tested state|artifact-relative implementation path/u,
    },
    {
      name: 'tested-state-hash',
      mutate: (text) => text.replace(/(## Implementation Test Evidence[\s\S]*?sha256:)[0-9a-f]{64}/u, `$1${'0'.repeat(64)}`),
      expected: /expected sha256:[0-9a-f]{64} but observed sha256:[0-9a-f]{64}/u,
    },
  ];
  for (const current of cases) {
    const candidateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `stnl-${current.name}-`)));
    t.after(() => fs.rm(candidateRoot, { recursive: true, force: true }));
    const candidateExecution = path.join(candidateRoot, 'execution');
    await fs.cp(path.join(fixture.spec, 'execution'), candidateExecution, { recursive: true });
    const candidateTask = path.join(candidateExecution, 'tasks/slice-01.md');
    await fs.writeFile(candidateTask, current.mutate(await fs.readFile(candidateTask, 'utf8')), 'utf8');
    await assert.rejects(validateExecutionCandidate(fixture.spec, candidateExecution), (error) => {
      assert.ok(error instanceof ExecutionContractError);
      assert.match(error.message, current.expected);
      return true;
    });
    assert.deepEqual(await fs.readFile(liveTask), liveBefore, `${current.name} candidate changed live execution`);
  }
});

test('observed r07-isolated workspace-segment path is rejected before a model call without correction', async (t) => {
  const fixture = await temporaryFixture(t, 'path-observed-invalid');
  const task = path.join(fixture.spec, 'execution/tasks/slice-01.md');
  const canonical = fixture.paths.taskImplementation;
  const observed = '../../../workspaces/r07-isolated/src/invitation.mjs';
  const invalid = (await fs.readFile(task, 'utf8')).replaceAll(canonical, observed);
  await fs.writeFile(task, invalid, 'utf8');
  const gate = await inspectFixturePathBasis({ workspace: fixture.workspace, spec: fixture.spec });
  assert.equal(gate.status, 'FIXTURE_PATH_BASIS_BLOCKED');
  assert.equal(gate.category, 'FIXTURE_PATH_BASIS');
  assert.equal(gate.rows.some((row) => row.storedPath === observed && row.result === 'FAIL'), true);
  assert.equal((await fs.readFile(task, 'utf8')).includes(observed), true, 'gate unexpectedly corrected the invalid path');
});

test('fixture path gate rejects a task-relative workspace escape', async (t) => {
  const fixture = await temporaryFixture(t, 'path-containment');
  const task = path.join(fixture.spec, 'execution/tasks/slice-01.md');
  const canonical = fixture.paths.taskImplementation;
  await fs.writeFile(task, (await fs.readFile(task, 'utf8')).replaceAll(canonical, '../../../../outside.mjs'), 'utf8');
  const gate = await inspectFixturePathBasis({ workspace: fixture.workspace, spec: fixture.spec });
  assert.equal(gate.status, 'FIXTURE_PATH_BASIS_BLOCKED');
  assert.equal(gate.rows.some((row) => row.inWorkspace === false), true);
});

test('raw managed workspace is rejected as HARNESS_WORKSPACE_GIT_NOT_READY before a model call', async (t) => {
  const session = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  t.after(() => cleanupManagedBenchmarkSession(session));
  const workspace = path.join(session.workspaces, 'raw-mkdir-only');
  await fs.mkdir(workspace, { recursive: true });
  const facts = await inspectHarnessWorkspaceGitGeometry({ session, workspace });
  assert.equal(facts.status, 'HARNESS_WORKSPACE_GIT_NOT_READY');
  assert.equal(facts.directoryExists, true);
  assert.equal(facts.canonical, true);
  assert.equal(facts.managed, true);
  assert.equal(facts.outsideRepository, true);
  assert.equal(facts.gitExists, false);
  assert.equal(facts.revParseTrue, false);
});

test('G01-G05 prepare independent Git-backed reviewer, B, and C workspaces without global mutation', async (t) => {
  const sessions = await Promise.all([
    createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT }),
    createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT }),
    createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT }),
  ]);
  t.after(async () => {
    for (const session of sessions.reverse()) await cleanupManagedBenchmarkSession(session);
  });
  const globalBefore = globalGitFingerprint();
  const names = ['reviewer', 'b-smoke', 'c-smoke'];
  const workspaces = [];
  for (let index = 0; index < sessions.length; index += 1) {
    workspaces.push(await prepareHarnessWorkspace(sessions[index], names[index]));
  }
  const facts = await Promise.all(workspaces.map((workspace, index) => (
    inspectHarnessWorkspaceGitGeometry({ session: sessions[index], workspace })
  )));
  for (const row of facts) {
    assert.equal(row.status, 'HARNESS_WORKSPACE_GIT_READY');
    assert.equal(row.directoryExists, true);
    assert.equal(row.canonical, true);
    assert.equal(row.managed, true);
    assert.equal(row.outsideRepository, true);
    assert.equal(row.gitExists, true);
    assert.equal(row.revParseTrue, true);
  }
  assert.notEqual(facts[1].workspace, facts[2].workspace);
  assert.notEqual(facts[1].gitDirectory, facts[2].gitDirectory);
  assert.notEqual(facts[1].sessionRoot, facts[2].sessionRoot);
  assert.notEqual(facts[1].runnerTmp, facts[2].runnerTmp);
  assert.equal(globalGitFingerprint(), globalBefore);
});
