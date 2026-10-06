import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseSemanticExecutionPayload } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
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
      const native = { ...response, automaticCheckRound: round, ...(operation === 'APPLY_FINDINGS' ? { findingsCycle: 'attempt-01' } : {}) };
      const parsed = parseSemanticExecutionPayload(JSON.stringify(native), operation);
      assert.equal(parsed.automaticCheckRound, round);
      assert.deepEqual(parsed.commands, response.commands);
    }

  }
});
for (const scenario of ['execute-scope-subset', 'execute-scope-correction', 'execute-round-divergence']) test(scenario, { timeout: 90_000 }, async t => {
  const fixture = await createOfflineCheckout(t, ROOT, scenario);
  console.log(`TEST-ONLY execute fixture: ${fixture.root}`);
  const run = spawnSync(process.execPath, ['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs', 'run', '--case', 'B'], { cwd: fixture.root, env: fixture.env, encoding: 'utf8', timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.writeFile(path.join(fixture.root, '.offline-execute-manager.log'), run.stdout + '\n' + run.stderr);
  const calls = (await fs.readFile(path.join(fixture.root, '.offline-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.externalCalls === 0 && call.caseId === 'B'));
  const runners = calls.filter(call => call.independent && call.operation === 'EXECUTE_SLICE');
  if (scenario === 'execute-scope-subset') {
    assert.equal(runners.length, 0, 'one-path request for six-path candidate must stop before dispatch');
    assert.notEqual(run.status, 0);
    const runId = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).find(name => name.startsWith('run-'));
    const caseRoot = path.join(fixture.root, 'benchmark-temp', runId, 'case-b');
    const state = JSON.parse(await fs.readFile(path.join(caseRoot, 'case-state.json')));
    const record = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
    assert.equal(record.operation, 'EXECUTE_SLICE');
    assert.match(record.turn.error, /EXECUTE payload scope differs from the prepared authorized candidate/);
    const binding = JSON.parse(await fs.readFile(path.join(caseRoot, 'tmp/stnl-runner-broker', String(record.sequence).padStart(3, '0') + '.candidate.json')));
    const candidate = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
    assert.equal(candidate.match(/## Changed Areas\n\n([\s\S]*?)(?=\n## )/u)[1].trim().split('\n').length, 6);
    assert.equal((await fs.readdir(path.join(caseRoot, 'tmp'))).filter(name => name.includes('-execute_slice-') && name.endsWith('.started.json')).length, 0);

  } else if (scenario === 'execute-scope-correction') {
    const observed = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-execute-scope-correction.json')));
    assert.equal(observed.firstExit, 1);
    assert.equal(observed.beforeStarts, 0);
    assert.equal(observed.secondExit, 0);
    assert.equal(observed.candidateUnchanged, true);
    assert.equal(observed.originalPaths.length, 1);
    assert.equal(observed.correctedPaths.length, 6);
    assert.equal(observed.secondReceipt.sequence, observed.sequence);
    assert.equal(observed.secondReceipt.testedState.entries.length, 6);
    assert.equal(observed.secondReceipt.semanticResponseStatus, 'TESTS_PASS');
    assert.equal(runners.length, 1);
    assert.equal(run.status, 0, run.stderr);
    const raw = JSON.parse(await fs.readFile(observed.secondReceipt.semanticResponseFile));
    assert.ok(raw.commands.length > 0 && raw.commands.every(command => command.exit === 0));
  } else {
    const observed = JSON.parse(await fs.readFile(path.join(fixture.root, '.offline-execute-round-observed.json')));
    assert.equal(runners.length, 3);
    assert.equal(observed.invalidAppends, 2, 'malformed prospective checks never mutate the private candidate');
    assert.equal(observed.extraExit, 1, 'terminal round cannot grant a fourth dispatch');
    assert.deepEqual(observed.after, observed.immutable);
    assert.deepEqual(observed.finalizedRounds.map(entry => entry.exit), [0, 0, 0]);
    assert.deepEqual(observed.finalizedRounds.map(entry => entry.result.state), ['PRIVATE_TESTS_FAIL', 'PRIVATE_TESTS_FAIL', 'IMPLEMENTATION_RETRY_EXHAUSTED']);
    for (let round = 1; round <= 3; round++) {
      assert.match(observed.publishedTask, new RegExp(`### implementation-check-0${round}[\\s\\S]*?- Automatic check round: ${round}/3`));
      assert.equal(JSON.parse(await fs.readFile(observed.receipts[round - 1].semanticResponseFile)).automaticCheckRound, '1/3');
    }
    assert.notEqual(run.status, 0, 'three real failed checks leave the case blocked');
  }
});
