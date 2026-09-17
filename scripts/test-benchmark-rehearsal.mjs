#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyBlockedStopPolicy,
  createCriticalFixture,
  inspectFixturePathBasis,
  preparePostR06Fixture,
  runDeterministicStages,
} from '../benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs';

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
