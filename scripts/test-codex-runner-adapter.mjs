import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {describeSemanticResponseFile,readRunnerConfiguration,invokeIndependentRunner} from '../agents/codex/runtime/validation-runner.mjs';
import { captureRunnerResponse } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { codexClientConfig, runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';
import { configText } from '../agents/codex/runtime/isolated-home.mjs';
import { formatRepairSource, sameFormatOnlyContent } from '../agents/codex/runtime/format-repair.mjs';
import { emptyFindingArrays, validationResponse, newlineCheck, usageCheck, correctedCheck } from './fixtures/validation-response-regressions.mjs';
import { parseSemanticValidationPayload } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
import { createUsageNormalizer, ZERO_USAGE } from '../agents/codex/runtime/usage-accounting.mjs';
import { frozenFileMode } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_ADAPTER = path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs');


test('unavailable managed runner refuses before dispatch',()=>{assert.throws(()=>invokeIndependentRunner({}),e=>e.code==='CURRENT_MANAGED_UNAVAILABLE');});
test('validation runner stays directly executable in the frozen benchmark snapshot', async () => {
  const metadata = await fs.stat(RUNNER_ADAPTER);
  assert.notEqual(metadata.mode & 0o111, 0);
  assert.equal(frozenFileMode(metadata.mode), 0o555);
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


test('format repair accepts bounded syntax fixes and preserves tokens in their original positions', () => {
  const valid = '{"status":"BLOCKED","head":"0123456789abcdef0123456789abcdef01234567","commands":[{"command":"node --test","exit":0}],"evidence":"same evidence","findingReferences":"none","findingDispositions":"none","blockers":"missing prerequisite","unexpectedWorkspaceEffects":"none","persistenceSummary":"none"}';
  const source = formatRepairSource(valid.slice(0, -1));
  assert.ok(source);
  assert.equal(sameFormatOnlyContent(source, valid), true);
  assert.equal(sameFormatOnlyContent(source, valid.replace('"BLOCKED"', '"PASS"')), false);
  assert.equal(sameFormatOnlyContent(source, valid.replace('same evidence', 'new evidence')), false);
  assert.equal(sameFormatOnlyContent(source, valid.replace('"commands":[', '"commands":{"extra":[')), false);
  assert.equal(formatRepairSource('{"status":"BLOCKED","evidence":"unfinished'), null);
  assert.ok(formatRepairSource(`\`\`\`json\n${valid}\n\`\`\``));
  assert.equal(sameFormatOnlyContent(formatRepairSource(valid.slice(0, -1) + ',}'), valid), true);
  assert.equal(sameFormatOnlyContent(formatRepairSource(valid.replace('"exit":0}', '"exit":0,}')), valid), true);
  assert.equal(sameFormatOnlyContent(formatRepairSource('{"a":[1],"b":2}'), '{"a":1,"b":[2]}'), false);
  assert.equal(formatRepairSource(valid.replace('"head":', '"head"')), null);
  assert.equal(formatRepairSource(`Here is the result: ${valid}`), null);
  assert.equal(formatRepairSource(valid.slice(0, -2)), null);
  assert.equal(formatRepairSource(valid.replace('"exit":0', '"exit":1 2')), null);
  assert.equal(formatRepairSource(' '.repeat(65537)), null);
  assert.equal(sameFormatOnlyContent(source, valid.replace('"exit":0', '"exit":1')), false);
  assert.equal(sameFormatOnlyContent(source, valid.replace('node --test', 'npm test')), false);
  assert.equal(sameFormatOnlyContent(source, `\`\`\`json\n${valid}\n\`\`\``), false);
});


test('schema preflight rejects the real empty-array shape before creating a deliverable', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-schema-preflight-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = path.join(root, 'events.jsonl');
  const output = path.join(root, 'response.json');
  const stream = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: emptyFindingArrays } }) + '\n';
  await fs.writeFile(events, stream);
  await assert.rejects(captureRunnerResponse({ structuredOutputFile: events, outputFile: output,
    validateResponse: parseSemanticValidationPayload }), (error) => error.code === 'RUNNER_RESPONSE_SCHEMA_INVALID');
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  assert.equal(await fs.readFile(events, 'utf8'), stream);
  const source = formatRepairSource(emptyFindingArrays);
  assert.deepEqual(source.emptyFindingFields, ['findingReferences', 'findingDispositions']);
  assert.deepEqual(parseSemanticValidationPayload(source.canonicalText), validationResponse());
  assert.equal(sameFormatOnlyContent(source, JSON.stringify(validationResponse())), true);
  assert.equal(sameFormatOnlyContent(source, JSON.stringify(validationResponse('PASS'))), false);
  assert.equal(sameFormatOnlyContent(source, source.canonicalText.replace('absent storage', 'existing storage')), false);
  for (const override of [{ findingReferences: ['finding-01'] }, { evidence: [] }, { findingReferences: null }]) {
    const unsupported = formatRepairSource(JSON.stringify({ ...validationResponse(), ...override }));
    assert.throws(() => parseSemanticValidationPayload(unsupported.canonicalText));
  }
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


test('SDK keeps provider schema event when the CLI later exits with stderr', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-sdk-schema-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'fake-codex.mjs');
  const eventsPath = path.join(root, 'events.jsonl');
  await fs.writeFile(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'thread-schema'}));\nconsole.log(JSON.stringify({type:'error',code:'invalid_json_schema',message:'invalid_json_schema'}));\nconsole.error('process exited after provider error');\nprocess.exit(1);\n`);
  await fs.chmod(cli, 0o755);
  const result = await runCodexTurn({ env: { CODEX_HOME: root }, cwd: root, prompt: 'offline',
    model: 'gpt-5.6-luna', effort: 'medium', operationId: 'schema-error', eventsPath, codexPathOverride: cli });
  assert.deepEqual(result.errorEvent, {
    operationId: 'schema-error', type: 'error', code: 'invalid_json_schema', message: 'invalid_json_schema',
  });
  assert.equal(result.error, 'invalid_json_schema');
  assert.match(result.processError, /process exited after provider error/u);
  assert.equal(result.errorEvent.code, 'invalid_json_schema');
  const persisted = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(persisted.find(({ type }) => type === 'error'), result.errorEvent);
});


test('runner instructions and skill isolation use per-instance public SDK config', async (t) => {
  await fs.mkdir(path.join(ROOT, 'benchmark-temp'), { recursive: true });
  const home = await fs.mkdtemp(path.join(ROOT, 'benchmark-temp/runner-config-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const shellHome = path.join(home, 'shell-home');
  const skills = path.join(shellHome, '.agents', 'skills');
  await fs.mkdir(path.join(skills, 'stnl-slice-executor'), { recursive: true });
  await fs.mkdir(path.join(skills, 'stnl-slice-quality-manager'));
  const configuration = await readRunnerConfiguration(ROOT);
  const runner = await codexClientConfig({ env: { CODEX_HOME: home, HOME: shellHome },
    developerInstructions: configuration.developerInstructions, isolateSkills: true });
  assert.equal(runner.developer_instructions, configuration.developerInstructions);
  assert.deepEqual(runner.skills.config, [
    { path: path.join(skills, 'stnl-slice-executor', 'SKILL.md'), enabled: false },
    { path: path.join(skills, 'stnl-slice-quality-manager', 'SKILL.md'), enabled: false },
  ]);
  assert.equal(runner.skills.bundled.enabled, false);
  const noDelegation = { agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: false },
    skills: { bundled: { enabled: false } } };
  assert.deepEqual(await codexClientConfig({ env: { CODEX_HOME: home } }), noDelegation);
  assert.equal(runner.agents.enabled, false);
  assert.equal(runner.features.multi_agent_v2, false);
  const privateConfig = configText({ privateHome: home, snapshot: ROOT, workspace: ROOT,
    candidates: home, tmpdir: home });
  assert.match(privateConfig, /\[agents\]\nenabled = false/u);
  assert.match(privateConfig, /\[features\][\s\S]*?multi_agent = false\nmulti_agent_v2 = false/u);
  await assert.rejects(codexClientConfig({ env: { CODEX_HOME: home }, isolateSkills: true }), /instructions are missing/u);
});


test('real SDK forwards delegation policy to CLI on start and resume without a provider', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-sdk-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'fake-codex.mjs');
  const calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(path.join(root, 'config.toml'), '[agents]\nenabled = true\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\n');
  await fs.writeFile(cli, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.STNL_FAKE_CLI_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'thread-fixture'}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));\n`);
  await fs.chmod(cli, 0o755);
  const env = { CODEX_HOME: root, STNL_FAKE_CLI_CAPTURE: calls };
  for (const [index, threadId] of [null, 'thread-fixture'].entries()) {
    const result = await runCodexTurn({ env, cwd: root, prompt: 'offline fixture', model: 'gpt-5.6-luna',
      effort: 'medium', threadId, operationId: `offline-${index}`, eventsPath: path.join(root, `events-${index}.jsonl`),
      ...(index === 0 ? { outputSchema: { type: 'object', properties: { status: { type: 'string' } } } } : {}),
      codexPathOverride: cli });
    assert.equal(result.completed, true, result.error);
  }
  const invocations = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  for (const args of invocations) {
    const overrides = args.flatMap((value, index) => args[index - 1] === '--config' ? [value] : []);
    for (const required of ['agents.enabled=false', 'features.multi_agent=false', 'features.multi_agent_v2=false']) {
      assert.ok(overrides.includes(required), `${required} must override inherited config`);
    }
  }
  assert.ok(invocations[1].includes('resume'));
  assert.ok(invocations[1].includes('thread-fixture'));
  assert.ok(invocations[0].includes('--output-schema'));
  const packagedCli = path.join(ROOT, 'agents/codex/node_modules/.bin/codex');
  const features = spawnSync(packagedCli, ['-c', 'agents.enabled=false', '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false', 'features', 'list'],
  { env: { ...process.env, CODEX_HOME: root }, encoding: 'utf8' });
  assert.equal(features.status, 0, features.stderr);
  assert.match(features.stdout, /^multi_agent\s+stable\s+false$/mu);
  assert.match(features.stdout, /^multi_agent_v2\s+stable\s+false$/mu);
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
