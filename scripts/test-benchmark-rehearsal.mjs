#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyBlockedStopPolicy,
  runDeterministicStages,
} from '../benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs';

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
