import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {claimValidationReassessment} from '../benchmarks/sentinel-todo/runtime/validation-reassessment.mjs';
test('owner policy exclusive claim admits one contender and does not reset on identity changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-reassessment-claim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const decision = { slice: 'slice-01', id: 'original', originalAttempt: 'attempt-01' };
  const results = await Promise.all(Array.from({ length: 12 }, () => claimValidationReassessment(root, decision)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(results.find(Boolean).claimFile)), decision);
  assert.equal(await claimValidationReassessment(root, { ...decision, id: 'new-fingerprint', originalAttempt: 'attempt-99' }), null);
});
