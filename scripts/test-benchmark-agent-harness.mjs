#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentHarnessContractVersion,
  buildCanonicalArgv,
  discoverProviderCapabilities,
  modelLabelForProviderId,
  runHarness,
} from '../benchmarks/sentinel-todo/runtime/benchmark-agent-harness.mjs';
import { invokeConfiguredValidationRunner } from '../benchmarks/sentinel-todo/runtime/benchmark-validation-runner.mjs';
import {
  collectConfiguredRunnerReceipts,
  SEMANTIC_RESPONSE_SCHEMA_PATH_BY_OPERATION,
} from '../benchmarks/sentinel-todo/runtime/benchmark-production-pilot.mjs';
import {
  cleanupManagedBenchmarkSession,
  createManagedBenchmarkSession,
} from '../benchmarks/sentinel-todo/runtime/benchmark-environment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAKE_PROVIDER = String.raw`
import fs from 'node:fs';

const [controlPath, capturePath, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const rootHelp = [
  'Codex CLI',
  'Usage: codex [OPTIONS] <COMMAND>',
  '  --ask-for-approval <APPROVAL_POLICY>',
  '  never',
  '  --disable <FEATURE>',
  control.rootHelpSuffix ?? '',
].filter((line) => !(control.missing ?? []).some((token) => line.includes(token))).join('\n');
const execHelp = [
  'Run Codex non-interactively',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  'Instructions are read from stdin.',
  '  --config <key=value>',
  '  --strict-config',
  '  --model <MODEL>',
  '  --sandbox <SANDBOX_MODE> read-only workspace-write',
  '  --cd <DIR>',
  '  --json',
  '  --ephemeral',
  '  --ignore-user-config',
  '  --ignore-rules',
  '  --output-schema <FILE>',
  control.execHelpSuffix ?? '',
].filter((line) => !(control.missing ?? []).some((token) => line.includes(token))).join('\n');

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(control.version ?? 'codex-cli test-1');
  process.exit(0);
}
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(rootHelp);
  process.exit(0);
}
if (args.length === 2 && args[0] === 'exec' && args[1] === '--help') {
  process.stdout.write(execHelp);
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(capturePath, JSON.stringify({
  args,
  cwd: process.cwd(),
  tmpdir: process.env.TMPDIR,
  prompt,
  pid: process.pid,
  gitRedirects: {
    dir: process.env.GIT_DIR ?? null,
    workTree: process.env.GIT_WORK_TREE ?? null,
    index: process.env.GIT_INDEX_FILE ?? null,
    objects: process.env.GIT_OBJECT_DIRECTORY ?? null,
    alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? null,
  },
}));

if (control.behavior === 'malformed') {
  process.stdout.write('not-json\n');
  process.exit(0);
}
if (control.behavior === 'init-failure') {
  process.stderr.write(control.stderrMessage ?? 'provider initialization rejected\n');
  process.exit(7);
}
if (control.behavior === 'model-failure') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { category: 'model' } }) + '\n');
  process.exit(8);
}
if (control.behavior === 'timeout') {
  setTimeout(() => process.exit(0), 30_000);
} else if (control.behavior === 'oversized') {
  process.stdout.write('x'.repeat(control.outputBytes ?? 262144));
  setTimeout(() => process.exit(0), 30_000);
} else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: control.message ?? 'PASS' } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
}
`;

async function fixture(t, control = {}) {
  const session = await createManagedBenchmarkSession({ repositoryRoot: ROOT });
  t.after(async () => {
    await cleanupManagedBenchmarkSession(session).catch(() => {});
  });
  const workspace = path.join(session.workspaces, 'workspace with spaces ü');
  await fs.mkdir(workspace);
  const fake = path.join(session.results, 'fake-provider.mjs');
  const controlPath = path.join(session.results, 'control.json');
  const capturePath = path.join(session.results, 'capture.json');
  await fs.writeFile(fake, FAKE_PROVIDER, 'utf8');
  await fs.writeFile(controlPath, JSON.stringify(control), 'utf8');
  const providerCommand = {
    command: process.execPath,
    argsPrefix: [fake, controlPath, capturePath],
  };
  const request = {
    model: 'GPT-5.6-Luna',
    effort: 'medium',
    sandbox: 'workspace-write',
    cwd: workspace,
    tmpdir: session.runnerTmp,
    prompt: 'probe prompt',
    timeoutMs: 3_000,
  };
  return { session, workspace, fake, controlPath, capturePath, providerCommand, request };
}

async function capture(item) {
  return JSON.parse(await fs.readFile(item.capturePath, 'utf8'));
}

async function runnerPreflightFixture(item, { recovery = false } = {}) {
  const specPath = path.join(item.workspace, 'specs', 'benchmark-case-c');
  await fs.mkdir(specPath, { recursive: true });
  await fs.writeFile(path.join(specPath, 'feature_spec.md'), '# Runner fixture\n', 'utf8');
  const mandatoryRecovery = recovery ? {
    operation: 'EXECUTE_SLICE',
    slice: 'slice-01',
    owner: 'delegation-blocker',
    sameOperationResumeRequired: true,
  } : null;
  return {
    specPath,
    officialPreflight: {
      exitCode: 0,
      operation: 'EXECUTE_SLICE',
      slice: 'slice-01',
      inputSlice: '1',
      specPath,
      state: recovery ? 'RUNNER_INITIALIZATION_BLOCKED' : 'MATERIALIZED_PRISTINE',
      authority: `sha256:${'a'.repeat(64)}`,
      legalOperations: [{ operation: 'EXECUTE_SLICE', slice: 'slice-01' }],
      mandatoryRecovery,
    },
  };
}

test('H01 — capability discovery accepts the complete fake CLI surface', async (t) => {
  const item = await fixture(t);
  const result = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal(result.fingerprint.harnessContractVersion, agentHarnessContractVersion);
  assert.deepEqual(result.missingCapabilities, []);
});

test('H02 — each mandatory structured/model/sandbox/effort capability fails closed', async (t) => {
  for (const token of ['--json', '--output-schema', '--sandbox', '--model', '--config', '--disable']) {
    await t.test(token, async (subtest) => {
      const item = await fixture(subtest, { missing: [token] });
      const result = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
      assert.equal(result.status, 'HARNESS_CAPABILITY_MISSING');
      assert.ok(result.missingCapabilities.length > 0);
    });
  }
});

test('H03 — approval control is long-form, global, and never placed after exec', async () => {
  const argv = buildCanonicalArgv({
    model: 'GPT-5.6-Luna', effort: 'medium', sandbox: 'workspace-write', cwd: '/canonical',
  });
  const shortApproval = `-${String.fromCharCode(97)}`;
  assert.equal(argv.includes(shortApproval), false);
  const execIndex = argv.indexOf('exec');
  const approvalIndex = argv.indexOf('--ask-for-approval');
  assert.ok(approvalIndex >= 0 && approvalIndex < execIndex);
  assert.equal(argv.slice(execIndex + 1).includes('--ask-for-approval'), false);
});

test('H03b — native multi-agent delegation can be disabled before exec', () => {
  const argv = buildCanonicalArgv({
    model: 'GPT-5.6-Luna', effort: 'medium', sandbox: 'workspace-write', cwd: '/canonical',
    disabledFeatures: ['multi_agent'],
  });
  const execIndex = argv.indexOf('exec');
  const disableIndex = argv.indexOf('--disable');
  assert.ok(disableIndex >= 0 && disableIndex < execIndex);
  assert.deepEqual(argv.slice(disableIndex, disableIndex + 2), ['--disable', 'multi_agent']);
  assert.equal(modelLabelForProviderId('gpt-5.6-luna'), 'GPT-5.6-Luna');
  assert.throws(() => modelLabelForProviderId('unsupported-model'), /unsupported provider model/u);
});

test('H04 — canonical argv is deterministic and independent of request property order', () => {
  const first = buildCanonicalArgv({ model: 'GPT-5.6-Terra', effort: 'high', sandbox: 'read-only', cwd: '/canonical' });
  const second = buildCanonicalArgv({ cwd: '/canonical', sandbox: 'read-only', effort: 'high', model: 'GPT-5.6-Terra' });
  assert.deepEqual(first, second);
});

test('H04b — semantic slice requests append the canonical structured-response schema', () => {
  const schema = '/canonical/runner-semantic-response.schema.json';
  const argv = buildCanonicalArgv({
    model: 'GPT-5.6-Luna', effort: 'xhigh', sandbox: 'workspace-write', cwd: '/canonical', outputSchema: schema,
  });
  const option = argv.indexOf('--output-schema');
  assert.ok(option >= 0);
  assert.equal(argv[option + 1], schema);
  assert.equal(argv.at(-1), '-');
});

test('H05 — Luna, Terra, and Sol each map once; unknown model rejects before spawn', async (t) => {
  for (const [requested, provider] of [
    ['GPT-5.6-Luna', 'gpt-5.6-luna'],
    ['GPT-5.6-Terra', 'gpt-5.6-terra'],
    ['GPT-5.6-Sol', 'gpt-5.6-sol'],
  ]) {
    const argv = buildCanonicalArgv({ model: requested, effort: 'medium', sandbox: 'read-only', cwd: '/canonical' });
    assert.equal(argv.filter((value) => value === provider).length, 1);
  }
  const item = await fixture(t);
  const result = await runHarness({ ...item.request, model: 'unknown' }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_MODEL_UNSUPPORTED');
  assert.equal(result.exitCode, 2);
  await assert.rejects(fs.access(item.capturePath));
});

test('H06 — all four efforts map explicitly and unknown effort rejects', async (t) => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const argv = buildCanonicalArgv({ model: 'GPT-5.6-Luna', effort, sandbox: 'read-only', cwd: '/canonical' });
    assert.ok(argv.includes(`model_reasoning_effort=${JSON.stringify(effort)}`));
  }
  const item = await fixture(t);
  const result = await runHarness({ ...item.request, effort: 'auto' }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_EFFORT_UNSUPPORTED');
});

test('H07 — read-only and workspace-write map explicitly and unknown sandbox rejects', async (t) => {
  for (const sandbox of ['read-only', 'workspace-write']) {
    const argv = buildCanonicalArgv({ model: 'GPT-5.6-Luna', effort: 'low', sandbox, cwd: '/canonical' });
    assert.equal(argv[argv.indexOf('--sandbox') + 1], sandbox);
  }
  const item = await fixture(t);
  const result = await runHarness({ ...item.request, sandbox: 'danger-full-access' }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_SANDBOX_UNSUPPORTED');
});

test('H08 — child receives the explicit canonical CWD with spaces and Unicode', async (t) => {
  const item = await fixture(t);
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal((await capture(item)).cwd, await fs.realpath(item.workspace));
});

test('H09 — managed TMPDIR is process environment, not prompt or command prefix', async (t) => {
  const item = await fixture(t);
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  const observed = await capture(item);
  assert.equal(observed.tmpdir, item.session.runnerTmp);
  assert.equal(observed.prompt.includes(item.session.runnerTmp), false);
  assert.equal(observed.args.includes(`TMPDIR=${item.session.runnerTmp}`), false);
  assert.deepEqual(Object.values(observed.gitRedirects), [null, null, null, null, null]);
});

test('H10 — stdin transports Unicode, quotes, newlines, and backticks byte-identically', async (t) => {
  const item = await fixture(t);
  const prompt = 'linha ü 漢字\n"quotes" \'single\' `backticks`\nMarkdown **ok**\n';
  const result = await runHarness({ ...item.request, prompt }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal((await capture(item)).prompt, prompt);
});

test('H11 — shell metacharacters remain literal and cannot create a file', async (t) => {
  const item = await fixture(t);
  const unexpected = path.join(item.workspace, 'expanded-by-shell');
  const prompt = `literal ; touch ${unexpected} && $(touch ${unexpected})`;
  const result = await runHarness({ ...item.request, prompt }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal((await capture(item)).prompt, prompt);
  await assert.rejects(fs.access(unexpected));
});

test('H12 — valid JSONL session and terminal turn produce HARNESS_COMPLETED', async (t) => {
  const item = await fixture(t, { message: 'terminal success' });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal(result.sessionStarted, true);
  assert.deepEqual(result.commandExitCodes, [0]);
  assert.equal(result.finalAssistantMessage, 'terminal success');
});

test('H12b — outputSchema is validated as a canonical regular file and reaches the provider', async (t) => {
  const item = await fixture(t);
  const schema = path.join(item.session.results, 'runner-semantic-response.schema.json');
  await fs.writeFile(schema, '{}\n', 'utf8');
  const result = await runHarness({ ...item.request, outputSchema: schema }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  const observed = await capture(item);
  const option = observed.args.indexOf('--output-schema');
  assert.ok(option >= 0);
  assert.equal(observed.args[option + 1], await fs.realpath(schema));
});

test('H13 — malformed structured output produces HARNESS_PROTOCOL_ERROR', async (t) => {
  const item = await fixture(t, { behavior: 'malformed' });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_PROTOCOL_ERROR');
});

test('H14 — provider nonzero before session start produces HARNESS_INIT_FAILED', async (t) => {
  const item = await fixture(t, {
    behavior: 'init-failure',
    stderrMessage: 'failed to initialize in-process app-server client: Operation not permitted; token=secret-sentinel\n',
  });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_INIT_FAILED');
  assert.equal(result.providerInvocationAccepted, false);
  assert.equal(result.providerErrorCategory, 'PROVIDER_ERROR');
  assert.equal(result.providerErrorDiagnosticCode, 'APP_SERVER_PERMISSION_DENIED');
  assert.doesNotMatch(JSON.stringify(result), /Operation not permitted|secret-sentinel/u);
});

test('H15 — terminal failure after session start produces MODEL_TURN_FAILED', async (t) => {
  const item = await fixture(t, { behavior: 'model-failure' });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'MODEL_TURN_FAILED');
  assert.equal(result.providerInvocationAccepted, true);
});

test('H16 — wall-clock timeout terminates the provider and is classified separately', async (t) => {
  const item = await fixture(t, { behavior: 'timeout' });
  const result = await runHarness({ ...item.request, timeoutMs: 150 }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_TIMEOUT');
  const observed = await capture(item);
  assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' });
});

test('H17 — excessive provider output is bounded and classified as protocol failure', async (t) => {
  const item = await fixture(t, { behavior: 'oversized', outputBytes: 262_144 });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand, outputLimit: 16_384 });
  assert.equal(result.status, 'HARNESS_PROTOCOL_ERROR');
  assert.equal(result.providerErrorCategory, 'OUTPUT_LIMIT');
});

test('H18 — canonical invocation contains the discovered isolation mechanisms only once', () => {
  const argv = buildCanonicalArgv({ model: 'GPT-5.6-Sol', effort: 'xhigh', sandbox: 'workspace-write', cwd: '/canonical' });
  for (const option of ['--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json']) {
    assert.equal(argv.filter((value) => value === option).length, 1);
  }
  for (const override of [
    'project_doc_max_bytes=0',
    'project_doc_fallback_filenames=[]',
    'shell_environment_policy.inherit="all"',
    'shell_environment_policy.experimental_use_profile=false',
    'shell_environment_policy.ignore_default_excludes=false',
  ]) assert.equal(argv.filter((value) => value === override).length, 1);
  assert.equal(argv.at(-1), '-');
});

test('H19 — identical capability surfaces produce identical fingerprints', async (t) => {
  const item = await fixture(t);
  const first = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  const second = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  assert.equal(first.fingerprint.capabilitiesHash, second.fingerprint.capabilitiesHash);
});

test('H20 — raw JSONL is persisted byte-for-byte only in the managed runner tmpdir', async (t) => {
  const item = await fixture(t);
  const structuredOutputFile = path.join(item.session.runnerTmp, 'raw-runner.jsonl');
  const result = await runHarness({ ...item.request, structuredOutputFile }, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal(result.structuredOutputFile, structuredOutputFile);
  const expected = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fake' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PASS' } }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ].join('\n');
  assert.equal(await fs.readFile(structuredOutputFile, 'utf8'), expected);

  const outside = path.join(item.session.results, 'outside.jsonl');
  const rejected = await runHarness({ ...item.request, structuredOutputFile: outside }, { providerCommand: item.providerCommand });
  assert.equal(rejected.status, 'HARNESS_INIT_FAILED');
  await assert.rejects(fs.access(outside));
});

test('H21 — configured runner uses the actual operation schema and preserves its raw semantic response', async (t) => {
  const item = await fixture(t, { message: '{"status":"BLOCKED"}' });
  const agents = path.join(item.workspace, '.codex', 'agents');
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, 'stnl_validation_runner.toml'), [
    'name = "stnl_validation_runner"',
    'description = "fixture runner config"',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = """',
    'Perform independent checks. Return only the requested JSON object.',
    '"""',
    '',
  ].join('\n'), 'utf8');

  const runnerPreflight = await runnerPreflightFixture(item, { recovery: true });

  const result = await invokeConfiguredValidationRunner({
    operation: 'EXECUTE_SLICE',
    sequence: 7,
    slice: 'slice-01',
    ...runnerPreflight,
    prompt: 'OPERATION=EXECUTE_SLICE; current approved task context only.',
    workspace: item.workspace,
    tmpdir: item.session.runnerTmp,
    providerCommand: item.providerCommand,
  });
  assert.equal(result.status, 'RUNNER_RESPONSE_CAPTURED');
  assert.equal(result.requestedModel, 'GPT-5.6-Luna');
  assert.equal(result.requestedEffort, 'medium');
  assert.equal(result.retryCount, 0);
  assert.equal(result.outputSchemaAttached, true);
  assert.equal(await fs.readFile(result.semanticResponseFile, 'utf8'), '{"status":"BLOCKED"}');
  assert.equal(path.dirname(result.structuredOutputFile), item.session.runnerTmp);

  const observed = await capture(item);
  const schemaIndex = observed.args.indexOf('--output-schema');
  assert.ok(schemaIndex >= 0);
  assert.equal(observed.args[schemaIndex + 1], SEMANTIC_RESPONSE_SCHEMA_PATH_BY_OPERATION.EXECUTE_SLICE);
  assert.equal(observed.args[observed.args.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.ok(observed.args.includes('model_reasoning_effort="medium"'));
  const disableIndex = observed.args.indexOf('--disable');
  assert.deepEqual(observed.args.slice(disableIndex, disableIndex + 2), ['--disable', 'multi_agent']);
  assert.equal(observed.cwd, item.workspace);
  assert.ok(observed.prompt.includes('Perform independent checks. Return only the requested JSON object.'));
  assert.ok(observed.prompt.includes('OPERATION=EXECUTE_SLICE; current approved task context only.'));
  assert.ok(observed.prompt.includes(`OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(runnerPreflight.officialPreflight)}`));
  assert.match(observed.prompt, /already ran the exact official execution preflight[\s\S]{0,180}Do not rerun or reconstruct/u);
  assert.match(observed.prompt, /mandatory recovery target matches/u);
});

test('H22 — malformed configured-runner output remains blocked and receives no repair or fallback', async (t) => {
  const item = await fixture(t, { message: 'translated prose, not JSON' });
  const agents = path.join(item.workspace, '.codex', 'agents');
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, 'stnl_validation_runner.toml'), [
    'name = "stnl_validation_runner"',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = """',
    'Return raw JSON.',
    '"""',
    '',
  ].join('\n'), 'utf8');
  const runnerPreflight = await runnerPreflightFixture(item);
  const result = await invokeConfiguredValidationRunner({
    operation: 'EXECUTE_SLICE', sequence: 9, slice: 'slice-01', prompt: 'execute check',
    ...runnerPreflight,
    workspace: item.workspace, tmpdir: item.session.runnerTmp, providerCommand: item.providerCommand,
  });
  assert.equal(result.status, 'RUNNER_RESULT_BLOCKED');
  assert.equal(result.semanticResponseFile, null);
  assert.match(result.captureFailure, /final runner message is not valid JSON/u);
  assert.equal(result.retryCount, 0);
  await assert.rejects(fs.access(path.join(item.session.runnerTmp, 'stnl-runner-009-execute_slice-slice-01-attempt-1.response.json')));
});

test('H23 — pre-session runner failure persists only a safe diagnostic code in its receipt', async (t) => {
  const errorText = 'failed to initialize in-process app-server client: Operation not permitted; token=secret-sentinel\n';
  const item = await fixture(t, { behavior: 'init-failure', stderrMessage: errorText });
  const agents = path.join(item.workspace, '.codex', 'agents');
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, 'stnl_validation_runner.toml'), [
    'name = "stnl_validation_runner"',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = """',
    'Return raw JSON.',
    '"""',
    '',
  ].join('\n'), 'utf8');
  const runnerPreflight = await runnerPreflightFixture(item);
  const result = await invokeConfiguredValidationRunner({
    operation: 'EXECUTE_SLICE', sequence: 10, slice: 'slice-01', prompt: 'execute check',
    ...runnerPreflight,
    workspace: item.workspace, tmpdir: item.session.runnerTmp, providerCommand: item.providerCommand,
  });
  assert.equal(result.status, 'RUNNER_INITIALIZATION_BLOCKED');
  assert.equal(result.sessionStarted, false);
  assert.equal(result.providerErrorDiagnosticCode, 'APP_SERVER_PERMISSION_DENIED');
  const receiptFile = path.join(item.session.runnerTmp, 'stnl-runner-010-execute_slice-slice-01-attempt-1.receipt.json');
  const receiptText = await fs.readFile(receiptFile, 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.providerErrorDiagnosticCode, 'APP_SERVER_PERMISSION_DENIED');
  assert.doesNotMatch(receiptText, /Operation not permitted|secret-sentinel/u);
  const evidence = await collectConfiguredRunnerReceipts({
    tmpdir: item.session.runnerTmp, sequence: 10, operation: 'EXECUTE_SLICE', slice: 'slice-01',
  });
  assert.deepEqual(evidence, [{
    attempt: 1,
    status: 'RUNNER_INITIALIZATION_BLOCKED',
    runnerAgent: 'stnl_validation_runner',
    requestedModel: 'GPT-5.6-Luna',
    requestedEffort: 'medium',
    outputSchemaAttached: true,
    harnessStatus: 'HARNESS_INIT_FAILED',
    retryCount: 0,
    sessionStarted: false,
    providerErrorCategory: 'PROVIDER_ERROR',
    providerErrorDiagnosticCode: 'APP_SERVER_PERMISSION_DENIED',
    semanticResponseCaptured: false,
  }]);
});

test('H24 — configured runner rejects a mismatched official recovery preflight before creating an invocation', async (t) => {
  const item = await fixture(t);
  const agents = path.join(item.workspace, '.codex', 'agents');
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, 'stnl_validation_runner.toml'), [
    'name = "stnl_validation_runner"',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = """',
    'Return raw JSON.',
    '"""',
    '',
  ].join('\n'), 'utf8');
  const runnerPreflight = await runnerPreflightFixture(item, { recovery: true });
  runnerPreflight.officialPreflight = {
    ...runnerPreflight.officialPreflight,
    slice: 'slice-02',
  };
  await assert.rejects(
    () => invokeConfiguredValidationRunner({
      operation: 'EXECUTE_SLICE', sequence: 12, slice: 'slice-01',
      ...runnerPreflight, prompt: 'execute check', workspace: item.workspace,
      tmpdir: item.session.runnerTmp, providerCommand: item.providerCommand,
    }),
    /RUNNER_PREFLIGHT_INVALID/u,
  );
  await assert.rejects(fs.access(path.join(
    item.session.runnerTmp,
    'stnl-runner-012-execute_slice-slice-01-attempt-1.invocation.json',
  )));
  await assert.rejects(fs.access(item.capturePath));
});

test('H20 — provider version or help changes invalidate the capability fingerprint', async (t) => {
  const item = await fixture(t, { version: 'codex-cli test-1' });
  const first = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  await fs.writeFile(item.controlPath, JSON.stringify({ version: 'codex-cli test-2', execHelpSuffix: 'new capability text' }), 'utf8');
  const second = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  assert.notEqual(first.fingerprint.capabilitiesHash, second.fingerprint.capabilitiesHash);
  assert.notEqual(first.fingerprint.providerVersion, second.fingerprint.providerVersion);
});
