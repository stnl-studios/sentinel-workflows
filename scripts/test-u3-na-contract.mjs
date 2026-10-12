import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseVerificationRecipe } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import { executeRunnerVerification, assertRunnerVerification } from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import { assertRunnerVerdictConsistency } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';

const rationale = 'Reviewed delivery has no executable verification command after inspection of its documentary output.';
const declaration = { discovery: 'Reviewed the approved documentary output and available repository checks; no runnable check observes this delivery.', rationale };
const recipe = { format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.', checks: [],
  dependencyReview: 'No executable imports or indirect check inputs exist for the documentary output.', nonApplicability: declaration };
const carrier = value => '- Recipe: ' + JSON.stringify(value);
const payload = { discoverySources: declaration.discovery, discoveryActions: 'Read the approved output and check inventory.',
  nonApplicabilityRationale: rationale, noVerificationCommandConfirmation: 'no verification command was executed' };

test('U3 reviewed N/A recipe produces a work-bound zero-command observation and no PASS or BLOCKED', async t => {
  assert.deepEqual(parseVerificationRecipe(carrier(recipe)), recipe);
  assert.throws(() => parseVerificationRecipe(carrier({ ...recipe, nonApplicability: undefined })), /Verification Recipe has unknown or missing fields/u);
  assert.throws(() => parseVerificationRecipe(carrier({ ...recipe, nonApplicability: { discovery: 'none', rationale } })), /objective reviewed evidence/u);
  const base = await mkdtemp(path.join(os.tmpdir(), 'stnl-u3-na-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'observation.json');
  let work = { output: 'reviewed documentary result' };
  const verification = { format: 'stnl-resolved-verification-v1', recipeSha256: 'sha256:' + '1'.repeat(64), checks: [], nonApplicability: declaration };
  const observation = await executeRunnerVerification({ verification, outputFile: file, observeState: () => work });
  assert.equal(observation.status, 'completed');
  assert.deepEqual(observation.checks, []);
  assert.deepEqual(assertRunnerVerification(observation, verification), []);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), observation);
  assert.doesNotThrow(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [], observation, payload));
  for (const status of ['TESTS_PASS', 'BLOCKED']) {
    assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', status, [], observation, payload), /reviewed zero-check recipe/u);
  }
  assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [{command:'echo unexpected',exit:0}], observation, payload), /zero-command observation/u);
  assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [], observation,
    { ...payload, nonApplicabilityRationale: 'unreviewed reason' }), /reviewed zero-check recipe/u);
  assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [], observation,
    { ...payload, discoveryActions: 'none' }), /objective discovery/u);
  assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [], observation,
    { ...payload, discoverySources: 'unreviewed discovery' }), /reviewed zero-check recipe/u);
  assert.throws(() => assertRunnerVerdictConsistency('EXECUTE_SLICE', 'TESTS_NOT_APPLICABLE', [],
    { ...observation, verification: { ...verification, nonApplicability: undefined } }, payload), /reviewed zero-check recipe/u);
  work = { output: 'changed after observation' };
  await assert.rejects(executeRunnerVerification({ verification, outputFile: file, observeState: () => work }), /stale/u);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), observation);
});
