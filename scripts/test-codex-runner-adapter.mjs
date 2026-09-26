import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRunnerRoundPayload, composeRunnerRequest, main as runnerMain,
  readRunnerConfiguration, submitRunnerPayload } from '../agents/codex/runtime/validation-runner.mjs';
import { codexClientConfig } from '../agents/codex/runtime/sdk-transport.mjs';
import { createUsageNormalizer, ZERO_USAGE } from '../agents/codex/runtime/usage-accounting.mjs';
import { frozenFileMode } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_ADAPTER = path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs');

function runnerArtifacts(workspace, slice = 'slice-01') {
  const executionRoot = path.join(workspace, 'specs/benchmark-case-a/execution');
  return {
    executionRoot,
    planPath: path.join(executionRoot, 'plan.md'),
    slicePlanPath: path.join(executionRoot, 'plans', `${slice}.md`),
    taskPath: path.join(executionRoot, 'tasks', `${slice}.md`),
  };
}

test('validation runner stays directly executable in the frozen benchmark snapshot', async () => {
  const metadata = await fs.stat(RUNNER_ADAPTER);
  assert.notEqual(metadata.mode & 0o111, 0);
  assert.equal(frozenFileMode(metadata.mode), 0o555);
});

test('independent runner receives mechanical context and semantic payload without role or producer instructions in the request', async () => {
  const configuration = await readRunnerConfiguration(ROOT);
  const workspace = path.join(ROOT, 'benchmark-temp/run-example/case-a/workspace');
  const snapshot = path.join(ROOT, 'benchmark-temp/run-example/snapshot');
  const serializer = path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
  const specPath = path.join(workspace, 'specs/benchmark-case-a');
  const officialPreflight = { operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath };
  const prompt = 'automaticCheckRound=1/3\nExact main-context semantic payload.';
  const request = composeRunnerRequest({ officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), prompt });
  assert.equal(configuration.model, 'gpt-5.6-luna');
  assert.equal(configuration.effort, 'medium');
  assert.equal((request.match(/RUNNER_EVIDENCE_SERIALIZER=/gu) ?? []).length, 0);
  assert.ok(!request.includes(serializer));
  assert.equal((request.match(/serialize-runner-evidence\.mjs/gu) ?? []).length, 0);
  assert.ok(!request.includes(configuration.developerInstructions));
  assert.ok(serializer.startsWith(`${snapshot}${path.sep}`));
  assert.ok(!request.includes(path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs')));
  assert.ok(!request.includes('/Library/Application Support/'));
  assert.equal((request.match(/MANAGED_WORKSPACE=/gu) ?? []).length, 1);
  assert.equal((request.match(/^SPEC_PATH=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^OPERATION=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^SLICE=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^EXECUTION_ROOT=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^PLAN_PATH=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^SLICE_PLAN_PATH=/gmu) ?? []).length, 1);
  assert.equal((request.match(/^TASK_PATH=/gmu) ?? []).length, 1);
  assert.ok(request.includes(`OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(officialPreflight)}`));
  assert.ok(request.endsWith(prompt));
  assert.throws(() => composeRunnerRequest({ officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), executionRoot: 'relative/root', prompt }), /context path is invalid/u);
  assert.throws(() => composeRunnerRequest({ officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), prompt: `automaticCheckRound=1/3\nRUNNER_EVIDENCE_SERIALIZER=/private/installed/skill/runtime/serialize-runner-evidence.mjs` }),
  /competing serializer authority/u);
});

test('automatic round is required before runner dispatch and managed CLI cannot bypass the bridge', async () => {
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    assert.throws(() => assertRunnerRoundPayload(operation, '{}'), /automaticCheckRound/u);
    assert.throws(() => assertRunnerRoundPayload(operation, 'automaticCheckRound=1/3\nautomaticCheckRound=2/3'), /automaticCheckRound/u);
    for (const round of ['1/3', '2/3', '3/3']) {
      assert.doesNotThrow(() => assertRunnerRoundPayload(operation, `automaticCheckRound=${round}`));
      assert.doesNotThrow(() => assertRunnerRoundPayload(operation, `{"automaticCheckRound":"${round}"}`));
    }
    await assert.rejects(submitRunnerPayload({ operation, slice: 'slice-01',
      cwd: '/nonexistent', prompt: '{}' }), /automaticCheckRound/u);
  }
  assert.doesNotThrow(() => assertRunnerRoundPayload('VALIDATE_SLICE', '{}'));
  await assert.rejects(runnerMain(['--operation', 'EXECUTE_SLICE', '--slice', 'slice-01'],
    { STNL_MANAGED_CONTEXT: '{}' }), /pathless bridge/u);
});

test('adapter rejects stale managed context before runner dispatch', async () => {
  const workspace = path.join(ROOT, 'benchmark-temp/run-ABC123/case-c/workspace');
  const officialPreflight = { exitCode: 0, operation: 'APPLY_FINDINGS', slice: 'slice-01',
    specPath: path.join(workspace, 'specs/case-c'), authority: `sha256:${'a'.repeat(64)}` };
  assert.throws(() => composeRunnerRequest({ officialPreflight,
    operation: 'EXECUTE_SLICE', slice: 'slice-01', workspace, ...runnerArtifacts(workspace),
    prompt: 'automaticCheckRound=1/3\nsemantic payload\nOPERATION=APPLY_FINDINGS' }), /competing|mechanical/u);
});

test('managed validation runner gets the official SPEC_PATH and rejects a private-home declaration', async () => {
  const workspace = path.join(ROOT, 'benchmark-temp/run-XYZ/case-c/workspace');
  const privateHome = path.join(ROOT, 'benchmark-temp/run-XYZ-c-AbCd12');
  const specPath = path.join(workspace, 'specs/case-c');
  const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-01', specPath };
  const request = composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), prompt: 'Review the current slice against requirements.' });
  assert.ok(request.includes(`SPEC_PATH=${specPath}\n\nOPERATION=VALIDATE_SLICE\n\nSLICE=slice-01`));
  assert.equal(request.includes(privateHome), false);
  assert.throws(() => composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace),
    prompt: `SPEC_PATH=${path.join(privateHome, 'case-c/workspace/specs/case-c')}` }),
  /competing mechanical identity/u);
});

test('runner instructions and skill isolation use per-instance public SDK config', async (t) => {
  const home = await fs.mkdtemp(path.join(ROOT, 'benchmark-temp/runner-config-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const skills = path.join(home, 'skills');
  await fs.mkdir(path.join(skills, 'stnl-slice-executor'), { recursive: true });
  await fs.mkdir(path.join(skills, 'stnl-slice-quality-manager'));
  const configuration = await readRunnerConfiguration(ROOT);
  const runner = await codexClientConfig({ env: { CODEX_HOME: home },
    developerInstructions: configuration.developerInstructions, isolateSkills: true });
  assert.equal(runner.developer_instructions, configuration.developerInstructions);
  assert.deepEqual(runner.skills.config, [
    { path: path.join(skills, 'stnl-slice-executor'), enabled: false },
    { path: path.join(skills, 'stnl-slice-quality-manager'), enabled: false },
  ]);
  assert.deepEqual(await codexClientConfig({ env: { CODEX_HOME: home } }), { features: { multi_agent: false } });
  await assert.rejects(codexClientConfig({ env: { CODEX_HOME: home }, isolateSkills: true }), /instructions are missing/u);
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
