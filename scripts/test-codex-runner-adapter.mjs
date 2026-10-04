import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRunnerRoundPayload, composeRunnerRequest, main as runnerMain,
  describeSemanticResponseFile, readRunnerConfiguration, scopeApplyFindingsSchema,
  submitRunnerPayload } from '../agents/codex/runtime/validation-runner.mjs';
import { captureRunnerResponse } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { codexClientConfig, runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';
import { configText } from '../agents/codex/runtime/isolated-home.mjs';
import { formatRepairSource, sameFormatOnlyContent } from '../agents/codex/runtime/format-repair.mjs';
import { emptyFindingArrays, validationResponse, newlineCheck, usageCheck, correctedCheck } from './fixtures/validation-response-regressions.mjs';
import { parseSemanticValidationPayload } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
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
  const officialPreflight = { exitCode: 0, operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath,
    legalOperations: [{ operation: 'EXECUTE_SLICE', slice: 'slice-01' }], mandatoryRecovery: null };
  const prompt = 'automaticCheckRound=1/3\nExact main-context semantic payload.';
  const request = composeRunnerRequest({ officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), prompt });
  assert.equal(configuration.model, 'gpt-6-luna');
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

test('Sentinel dispatch omits remote canonical output schema independently of replay fixtures', async () => {
  const source = await fs.readFile(RUNNER_ADAPTER, 'utf8');
  const invocation = /turn = await runTurn\(\{([\s\S]*?)\n    \}\);/u.exec(source)?.[1];
  assert.ok(invocation, 'runner dispatch call must remain visible');
  assert.doesNotMatch(invocation, /outputSchema/u);
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

test('local APPLY_FINDINGS schema scoping remains available for canonical cycle checks', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT,
    'skills/workflows/stnl-slice-executor/runtime/runner-apply-findings-response.schema.json'), 'utf8'));
  const state = { tasks: new Map([['slice-01', { attempts: [
    { id: 'attempt-01', status: 'NEEDS_FIX' }, { id: 'attempt-02', status: 'NEEDS_FIX' },
  ] }]]) };
  assert.deepEqual(scopeApplyFindingsSchema(schema, state, 'slice-01').properties.findingsCycle,
    { type: 'string', enum: ['attempt-02'] });
  assert.deepEqual(schema.properties.findingsCycle, { type: 'string', pattern: '^[^\\r\\n`]+$' });
  assert.throws(() => scopeApplyFindingsSchema(schema, state, 'slice-02'), /no canonical active findings cycle/u);
  assert.throws(() => scopeApplyFindingsSchema(schema, { tasks: new Map([['slice-01', {
    attempts: [{ id: 'finding-01', status: 'NEEDS_FIX' }],
  }]]) }, 'slice-01'), /no canonical active findings cycle/u);
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
  const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-01', specPath,
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-01' }], mandatoryRecovery: null };
  const request = composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace), prompt: 'Review the current slice against requirements.' });
  assert.ok(request.includes(`SPEC_PATH=${specPath}\n\nOPERATION=VALIDATE_SLICE\n\nSLICE=slice-01`));
  assert.equal(request.includes(privateHome), false);
  assert.throws(() => composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-01', workspace, ...runnerArtifacts(workspace),
    prompt: `SPEC_PATH=${path.join(privateHome, 'case-c/workspace/specs/case-c')}` }),
  /competing mechanical identity/u);
});

test('validation payload preserves historical overlap without replacing the current envelope', () => {
  const workspace = path.join(ROOT, 'benchmark-temp/run-fixture/case-a/workspace');
  const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-02',
    specPath: path.join(workspace, 'specs/fixture'),
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-02' }], mandatoryRecovery: null };
  const payload = { objective: 'Validate current behavior and the prior overlap.',
    acceptance_criteria: ['Invalid filters preserve storage and return a usage error.'],
    overlap: { slice: '01', paths: ['src/cli.mjs', 'test/cli.test.mjs'], prior_result: 'PASS',
      required_regression: 'Prepared assertions must still prove valid filtering and ordering.' } };
  for (const prompt of [JSON.stringify(payload), `\n${JSON.stringify(payload, null, 2)}\n`]) {
    const request = composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
      slice: 'slice-02', workspace, ...runnerArtifacts(workspace, 'slice-02'), prompt });
    assert.equal(request.endsWith(prompt), true, 'semantic payload bytes must remain intact');
    assert.equal((request.match(/^SLICE=slice-02$/gmu) ?? []).length, 1);
    assert.equal((request.match(/^OPERATION=VALIDATE_SLICE$/gmu) ?? []).length, 1);
    assert.ok(request.includes(`TASK_PATH=${runnerArtifacts(workspace, 'slice-02').taskPath}\n`));
  }
});

test('validation payload rejects top-level mechanical identity and envelope assignments', () => {
  const workspace = path.join(ROOT, 'benchmark-temp/run-fixture/case-a/workspace');
  const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-02',
    specPath: path.join(workspace, 'specs/fixture'),
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-02' }], mandatoryRecovery: null };
  const compose = (prompt) => composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-02', workspace, ...runnerArtifacts(workspace, 'slice-02'), prompt });
  for (const field of ['operation', 'specPath', 'workspace', 'slice', 'executionRoot', 'planPath',
    'slicePlanPath', 'taskPath', 'adapterPath', 'snapshotPath']) {
    assert.throws(() => compose(JSON.stringify({ objective: 'Review.', [field]: 'competing identity',
      overlap: { slice: '01' } })), /competing mechanical identity/u, field);
  }
  assert.throws(() => compose('{"objective":"Review.","\\u0073lice":"slice-01"}'),
    /competing mechanical identity/u, 'decoded JSON keys remain authoritative');
  for (const field of ['SPEC_PATH', 'MANAGED_WORKSPACE', 'OPERATION', 'SLICE', 'EXECUTION_ROOT',
    'PLAN_PATH', 'SLICE_PLAN_PATH', 'TASK_PATH', 'RUNNER_BRIDGE', 'STNL_RUNNER_ADAPTER']) {
    assert.throws(() => compose(`Review.\n${field}=competing identity`), /competing mechanical identity/u, field);
  }
});

test('validation text and malformed JSON retain conservative identity and serializer guards', () => {
  const workspace = path.join(ROOT, 'benchmark-temp/run-fixture/case-a/workspace');
  const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-02',
    specPath: path.join(workspace, 'specs/fixture'),
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-02' }], mandatoryRecovery: null };
  const compose = (prompt) => composeRunnerRequest({ officialPreflight, operation: 'VALIDATE_SLICE',
    slice: 'slice-02', workspace, ...runnerArtifacts(workspace, 'slice-02'), prompt });
  for (const prompt of ['Review current behavior.', '{"objective":"Review."']) {
    assert.equal(compose(prompt).endsWith(prompt), true, 'this guard does not validate semantic JSON');
  }
  for (const prompt of ['Review: "slice": "slice-01"', '{"overlap":{"slice":"01"',
    '[{"slice":"slice-01"}]', '{"objective":"Review."}\nSLICE=slice-01']) {
    assert.throws(() => compose(prompt), /competing mechanical identity/u);
  }
  for (const prompt of ['{"overlap":{"evidence":"RUNNER_EVIDENCE_SERIALIZER=/other"}}',
    '{"overlap":{"evidence":"serialize-runner-evidence.mjs"}}']) {
    assert.throws(() => compose(prompt), /competing serializer authority/u);
  }
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
