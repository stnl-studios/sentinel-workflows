import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {describeSemanticResponseFile,readRunnerConfiguration} from '../agents/codex/runtime/validation-runner.mjs';
import { captureRunnerResponse } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { emptyFindingArrays, validationResponse, newlineCheck, usageCheck, correctedCheck } from './fixtures/validation-response-regressions.mjs';
import { parseSemanticValidationPayload } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
import { createUsageNormalizer, ZERO_USAGE, appServerUsageObservations, projectAppServerMeasurement } from '../agents/codex/runtime/usage-accounting.mjs';
import { frozenFileMode } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_ADAPTER = path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs');

// Synthetic protocol counters exercise accounting only, never paid consumption.
const tokens = (input, output = 2, cached = 0) => ({ inputTokens: input, outputTokens: output,
  cachedInputTokens: cached, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: input + output });
const scope = (threadId, turnId, extra = {}) => ({ type: 'native.usage.scope', scope: {
  source: 'main', threadId, turnId, operationId: turnId, fresh: true, proof: 'thread/start', ...extra } });
const notification = (threadId, turnId, total, last = total) => ({ type: 'native.usage.notification', observationId: randomUUID(),
  notification: projectAppServerMeasurement({ method: 'thread/tokenUsage/updated',
    params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 200000 } } }) });
const terminal = (threadId, turnId, status = 'completed') => ({ type: 'native.usage.notification', observationId: randomUUID(),
  notification: projectAppServerMeasurement({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } }) });

test('App Server counters use final cumulative total, not last or repeated rate-limit snapshots', () => {
  const a = notification('main', 'one', tokens(20, 4, 8), tokens(10, 2, 4));
  const events = [scope('main', 'one'), notification('main', 'one', tokens(10, 2, 4)), a, a, terminal('main', 'one'), a];
  const result = appServerUsageObservations(events);
  assert.deepEqual(result.issues, []);
  assert.equal(result.observations[0].status, 'attributable');
  assert.deepEqual(result.observations[0].delta, { input: 20, cachedInput: 8, cacheWrite: 0, output: 4, reasoningOutput: 0, total: 24 });
  assert.equal(result.observations[0].billing, false);
  assert.deepEqual(appServerUsageObservations([...events, ...events]), result, 'persisted replay is idempotent');
});

test('App Server main/child and failed/retried turns have independent scope and retained baselines', () => {
  const events = [scope('main', 'failed'), notification('main', 'failed', tokens(10)), terminal('main', 'failed', 'failed'),
    scope('main', 'retry', { fresh: false, proof: 'retained-thread' }), notification('main', 'retry', tokens(30, 6)), terminal('main', 'retry'),
    scope('child', 'review', { source: 'runner', proof: 'public-child-no-fork', forkedFromId: null }),
    notification('child', 'review', tokens(7, 1)), terminal('child', 'review')];
  const result = appServerUsageObservations(events);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.observations.map(o => [o.source, o.status, o.delta.total, o.turnStatus]),
    [['main', 'attributable', 12, 'failed'], ['main', 'attributable', 24, 'completed'], ['runner', 'attributable', 8, 'completed']]);
});

test('App Server inherited or missing child usage stays partial and cannot count the shared prefix', () => {
  const forged = appServerUsageObservations([scope('child','one',{source:'runner',proof:'thread/start',forkedFromId:'parent'}),
    notification('child','one',tokens(100)),terminal('child','one')]);
  assert.equal(forged.observations[0].status,'partial','a main birth proof cannot authorize a child zero baseline');
  for (const forkedFromId of ['parent', 'unknown']) {
    const result = appServerUsageObservations([scope('child', 'one', { source: 'runner', proof: 'public-child-no-fork', forkedFromId }),
      notification('child', 'one', tokens(100)), terminal('child', 'one'),
      scope('child', 'two', { source: 'runner', fresh: false, proof: 'retained-thread' }),
      notification('child', 'two', tokens(110, 4)), terminal('child', 'two')]);
    assert.equal(result.observations[0].status, 'partial'); assert.equal(result.observations[0].delta, null);
    assert.equal(result.observations[1].delta.total, 12, 'only the later known delta may be reported as a subtotal');
  }
  const missing = appServerUsageObservations([scope('child', 'one', { source: 'runner' }), terminal('child', 'one')]);
  assert.match(missing.observations[0].reason, /snapshot missing/u);
  assert.equal(missing.observations[0].delta, null);
});

test('App Server context estimates in last do not alter total; synthetic totals, reset and impossible cache are refused', () => {
  const estimate = { ...tokens(0, 0), totalTokens: 5000 };
  const ok = appServerUsageObservations([scope('main', 'one'), notification('main', 'one', tokens(10), estimate), terminal('main', 'one')]);
  assert.equal(ok.observations[0].delta.total, 12);
  for (const changed of [estimate, tokens(5, 1), tokens(20, 4, 21)]) {
    const result = appServerUsageObservations([scope('main', 'one'), notification('main', 'one', tokens(10, 2)),
      notification('main', 'one', changed), terminal('main', 'one')]);
    assert.equal(result.observations[0].status, 'partial'); assert.equal(result.observations[0].delta, null);
  }
});

test('App Server late changed snapshots invalidate the boundary and subsequent turn rather than combining fragments', () => {
  const result = appServerUsageObservations([scope('main', 'one'), notification('main', 'one', tokens(10)), terminal('main', 'one'),
    scope('main', 'two', { fresh: false, proof: 'retained-thread' }), notification('main', 'two', tokens(20, 4)), terminal('main', 'two'),
    notification('main', 'one', tokens(12))]);
  assert.ok(result.observations.every(o => o.status === 'partial' && o.delta === null && o.reason.includes('late changed total')));
});

test('App Server a newly received counter decrease cannot masquerade as replay of an older value', () => {
  const first=notification('main','one',tokens(10));
  const reset={...notification('main','one',tokens(10)),observedAt:'new observation'};
  const result=appServerUsageObservations([scope('main','one'),first,notification('main','one',tokens(20,4)),reset,terminal('main','one')]);
  assert.equal(result.observations[0].status,'partial');assert.equal(result.observations[0].delta,null);
  const missing={...first};delete missing.observationId;
  assert.ok(appServerUsageObservations([scope('main','one'),missing,terminal('main','one')]).issues.includes('missing observation identity'));
  const conflict={...notification('main','one',tokens(30)),observationId:first.observationId};
  assert.ok(appServerUsageObservations([scope('main','one'),first,conflict,terminal('main','one')]).issues.includes('conflicting observation identity'));
});

test('App Server missing terminal, unchanged totals, invalid scope and conflicting roles never certify completeness', () => {
  const cases = [
    [scope('main', 'one'), notification('main', 'one', tokens(10))],
    [scope('main', 'one'), notification('main', 'one', tokens(0, 0)), terminal('main', 'one')],
    [scope('main', 'one'), notification('main', 'one', tokens(10)), terminal('main', 'one', 'unknown')],
    [scope('main', 'one'), { type: 'native.usage.unavailable' }],
  ];
  for (const events of cases) assert.ok(appServerUsageObservations(events).observations.every(o => o.status === 'partial'));
  assert.ok(appServerUsageObservations([scope('main', 'one'), scope('main', 'one', { source: 'runner' })]).issues.includes('conflicting usage scope'));
  assert.ok(appServerUsageObservations([scope('bad path', 'one')]).issues.includes('invalid usage scope'));
  for (const invalid of [null, 1, [], 'private secret'])
    assert.deepEqual(appServerUsageObservations([invalid]).issues, ['invalid measurement event']);
  assert.ok(appServerUsageObservations([scope('main', 'one'), notification('main', 'other', tokens(10))]).issues.includes('unbound turn usage'));
  const foreign=appServerUsageObservations([scope('main','one'),notification('main','one',tokens(10)),terminal('main','one'),notification('foreign','other',tokens(7))]);
  assert.ok(foreign.issues.includes('unbound thread usage'));
  assert.equal(foreign.observations.length,1,'foreign usage is diagnosed but never charged');
});

test('App Server projection omits contents and secrets and preserves malformed-not-zero diagnostics', () => {
  const result = projectAppServerMeasurement({ method: 'thread/tokenUsage/updated', params: {
    threadId: 'main', turnId: 'one', tokenUsage: { total: tokens(10), last: tokens(10), credentials: 'SECRET' },
    output: 'SECRET', environment: 'SECRET' } });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|credentials|environment|output"/u);
  assert.equal(projectAppServerMeasurement({ method: 'item/completed', params: { text: 'SECRET' } }), null);
  assert.equal(projectAppServerMeasurement({ method: 'thread/tokenUsage/updated', params: { threadId: 'main', turnId: 'one', tokenUsage: {} } }).method, 'invalid');
});


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
