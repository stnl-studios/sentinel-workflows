import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { composeRunnerRequest, readRunnerConfiguration } from '../agents/codex/runtime/validation-runner.mjs';
import { createUsageNormalizer, ZERO_USAGE } from '../agents/codex/runtime/usage-accounting.mjs';
import { frozenFileMode } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_ADAPTER = path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs');

test('validation runner stays directly executable in the frozen benchmark snapshot', async () => {
  const metadata = await fs.stat(RUNNER_ADAPTER);
  assert.notEqual(metadata.mode & 0o111, 0);
  assert.equal(frozenFileMode(metadata.mode), 0o555);
});

test('independent runner receives adapter-owned serializer and managed workspace context', async () => {
  const configuration = await readRunnerConfiguration(ROOT);
  const workspace = path.join(ROOT, 'benchmark-temp/run-example/case-a/workspace');
  const serializer = path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
  const specPath = path.join(workspace, 'specs/benchmark-case-a');
  const officialPreflight = { operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath };
  const prompt = 'Exact main-context semantic payload.';
  const request = composeRunnerRequest({ configuration, officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, serializer, prompt });
  assert.equal(configuration.model, 'gpt-5.6-luna');
  assert.equal(configuration.effort, 'medium');
  assert.ok(request.includes(`RUNNER_EVIDENCE_SERIALIZER=${serializer}\n\n`));
  assert.ok(request.includes(`MANAGED_WORKSPACE=${workspace}\n\n`));
  assert.ok(request.includes(`SPEC_PATH=${specPath}\n\n`));
  assert.ok(request.includes(`OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(officialPreflight)}`));
  assert.ok(request.endsWith(prompt));
  assert.throws(() => composeRunnerRequest({ configuration, officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, serializer: 'relative/serializer.mjs', prompt }), /context path is invalid/u);
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
