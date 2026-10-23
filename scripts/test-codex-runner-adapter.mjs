import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {describeSemanticResponseFile,readRunnerConfiguration} from '../agents/codex/runtime/validation-runner.mjs';
import { captureRunnerResponse } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { emptyFindingArrays, validationResponse, newlineCheck, usageCheck, correctedCheck } from './fixtures/validation-response-regressions.mjs';
import { parseSemanticValidationPayload } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
import { createUsageNormalizer, ZERO_USAGE } from '../agents/codex/runtime/usage-accounting.mjs';
import { frozenFileMode } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_ADAPTER = path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs');


test('receipt describes the captured final semantic response despite intermediate BLOCKED messages', async (t) => {
  await fs.mkdir(path.join(ROOT, 'benchmark-temp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT, 'benchmark-temp/runner-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventsPath = path.join(root, 'events.jsonl');
  const responsePath = path.join(root, 'response.json');
  const intermediate = { status: 'BLOCKED', evidenceOrFailureSummary: 'intermediate update' };
  const finalResponse = { status: 'TESTS_PASS', evidenceOrFailureSummary: 'all checks pass' };
  await fs.writeFile(eventsPath, [intermediate, finalResponse].map((value) => JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) },
  })).join('\n') + '\n');
  await captureRunnerResponse({ structuredOutputFile: eventsPath, outputFile: responsePath });
  const description = await describeSemanticResponseFile(responsePath);
  const bytes = await fs.readFile(responsePath);
  assert.deepEqual(description, {
    semanticResponseStatus: 'TESTS_PASS',
    semanticResponseSha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.equal(JSON.parse(bytes).status, 'TESTS_PASS');
});


test('invalid local semantic JSON is rejected after capture without provider schema', async (t) => {
  await fs.mkdir(path.join(ROOT, 'benchmark-temp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT, 'benchmark-temp/local-semantic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventsPath = path.join(root, 'events.jsonl');
  await fs.writeFile(eventsPath, `${JSON.stringify({ type: 'item.completed', item: {
    type: 'agent_message', text: '{"status":' } })}\n`);
  await assert.rejects(captureRunnerResponse({ structuredOutputFile: eventsPath,
    outputFile: path.join(root, 'response.json') }), /not valid JSON/u);
});


test('sanitized ad hoc check fixtures reproduce both real failures and their corrected check', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-check-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, code, exit, error] of [
    ['newline', newlineCheck, 1, /1 !== 0/u],
    ['usage', usageCheck, 1, /did not match the regular expression/u],
    ['corrected', correctedCheck, 0, /^$/u],
  ]) {
    const script = path.join(root, name + '.mjs');
    await fs.writeFile(script, code);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, exit, result.stderr);
    assert.match(result.stderr, error);
  }
});


test('usage normalizer attributes cumulative snapshots from a known baseline exactly once', () => {
  const normalizer = createUsageNormalizer({ baseline: ZERO_USAGE, source: 'main' });
  const observation = (input_tokens) => normalizer.observe({
    threadId: 'thread-main', segment: 'turn-01',
    usage: { input_tokens, cached_input_tokens: input_tokens - 20, output_tokens: 0, reasoning_output_tokens: 0 },
  });
  assert.equal(observation(100).delta.total, 100);
  assert.equal(observation(180).delta.total, 80);
  assert.equal(observation(250).delta.total, 70);
  const duplicate = observation(250);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.delta.total, 0);
});


test('usage normalizer reports unknown baselines, resets, forks, and incomplete runner events', () => {
  const unknown = createUsageNormalizer({ source: 'main' });
  assert.equal(unknown.observe({ threadId: 'thread-a', segment: 'turn-01', usage: { input_tokens: 100 } }).status, 'unavailable');
  assert.equal(unknown.observe({ threadId: 'thread-a', segment: 'turn-01', usage: { input_tokens: 80 } }).status, 'unavailable');

  const runner = createUsageNormalizer({ baseline: ZERO_USAGE, source: 'runner' });
  assert.equal(runner.observe({ threadId: 'runner-a', segment: 'attempt-01', usage: null }).status, 'unavailable');
  const first = runner.observe({ threadId: 'runner-a', segment: 'attempt-01', usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(first.status, 'attributable');
  assert.equal(first.delta.total, 25);
  const fork = runner.observe({ threadId: 'runner-b', segment: 'attempt-01', parentThreadId: 'runner-a', usage: { input_tokens: 1 } });
  assert.equal(fork.status, 'partial');
  assert.equal(fork.reason, 'fork detected');
});


test('usage reset is partial and independent runner observations are counted once', () => {
  const main = createUsageNormalizer({ baseline: ZERO_USAGE, source: 'main' });
  const observeMain = (input_tokens, output_tokens) => main.observe({ threadId: 'thread-main', segment: 'run-1',
    usage: { input_tokens, output_tokens } });
  assert.equal(observeMain(100, 20).delta.total, 120);
  const reset = observeMain(80, 30);
  assert.equal(reset.status, 'partial');
  assert.equal(reset.reason, 'decrease/reset/fork detected');
  assert.deepEqual(reset.fields, ['input_tokens']);
  assert.equal(observeMain(110, 35).delta.total, 35);

  const runner = createUsageNormalizer({ baseline: ZERO_USAGE, source: 'runner' });
  const first = runner.observe({ threadId: 'runner-1', segment: 'run-1', usage: { input_tokens: 30, output_tokens: 5 } });
  const duplicate = runner.observe({ threadId: 'runner-1', segment: 'run-1', usage: { input_tokens: 30, output_tokens: 5 } });
  const second = runner.observe({ threadId: 'runner-2', segment: 'run-1', usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(first.delta.total + duplicate.delta.total + second.delta.total, 47);
});
