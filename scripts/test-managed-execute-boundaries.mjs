import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseSemanticExecutionPayload } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
test('admitted rounds own bookkeeping while raw echoes remain diagnostic', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/runner-semantic-response.schema.json')));
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    const shape = schema.oneOf.find(branch => branch.title === operation);
    const response = Object.fromEntries(shape.required.map(key => [key, 'checked']));
    Object.assign(response, { status: 'TESTS_FAIL', commands: [{ command: 'node --test', exit: 1 }] });
    for (const round of ['1/3', '2/3', '3/3']) for (const echo of [undefined, '1/3', '3/3', null, { arbitrary: true }]) {
      const raw = JSON.stringify({ ...response, ...(echo === undefined ? {} : { automaticCheckRound: echo }) });
      const parsed = parseSemanticExecutionPayload(raw, operation, { automaticCheckRound: round });
      assert.equal(parsed.automaticCheckRound, round);
      assert.equal(parsed.status, 'TESTS_FAIL');
      assert.deepEqual(parsed.commands, response.commands);
      assert.equal(raw, JSON.stringify(JSON.parse(raw)));
    }
    assert.throws(() => parseSemanticExecutionPayload(JSON.stringify(response), operation, { automaticCheckRound: '4/3' }));
    assert.ok(!shape.required.includes('automaticCheckRound'));
    assert.match(shape.properties.automaticCheckRound.description, /Native producers require an explicit canonical/);
    for (const omittedOrInvalid of [undefined, null, '4/3', { legacy: true }]) {
      const native = { ...response, ...(omittedOrInvalid === undefined ? {} : { automaticCheckRound: omittedOrInvalid }) };
      assert.throws(() => parseSemanticExecutionPayload(JSON.stringify(native), operation));
    }
    for (const round of ['1/3', '2/3', '3/3']) {
      const native = { ...response, automaticCheckRound: round };
      const parsed = parseSemanticExecutionPayload(JSON.stringify(native), operation);
      assert.equal(parsed.automaticCheckRound, round);
      assert.deepEqual(parsed.commands, response.commands);
    }

  }
});
