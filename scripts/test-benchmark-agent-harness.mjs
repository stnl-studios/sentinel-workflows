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
  runHarness,
} from '../benchmarks/sentinel-todo/runtime/benchmark-agent-harness.mjs';
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
  control.rootHelpSuffix ?? '',
].join('\n');
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
  process.stderr.write('provider initialization rejected\n');
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

test('H01 — capability discovery accepts the complete fake CLI surface', async (t) => {
  const item = await fixture(t);
  const result = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_COMPLETED');
  assert.equal(result.fingerprint.harnessContractVersion, agentHarnessContractVersion);
  assert.deepEqual(result.missingCapabilities, []);
});

test('H02 — each mandatory structured/model/sandbox/effort capability fails closed', async (t) => {
  for (const token of ['--json', '--sandbox', '--model', '--config']) {
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

test('H04 — canonical argv is deterministic and independent of request property order', () => {
  const first = buildCanonicalArgv({ model: 'GPT-5.6-Terra', effort: 'high', sandbox: 'read-only', cwd: '/canonical' });
  const second = buildCanonicalArgv({ cwd: '/canonical', sandbox: 'read-only', effort: 'high', model: 'GPT-5.6-Terra' });
  assert.deepEqual(first, second);
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

test('H13 — malformed structured output produces HARNESS_PROTOCOL_ERROR', async (t) => {
  const item = await fixture(t, { behavior: 'malformed' });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_PROTOCOL_ERROR');
});

test('H14 — provider nonzero before session start produces HARNESS_INIT_FAILED', async (t) => {
  const item = await fixture(t, { behavior: 'init-failure' });
  const result = await runHarness(item.request, { providerCommand: item.providerCommand });
  assert.equal(result.status, 'HARNESS_INIT_FAILED');
  assert.equal(result.providerInvocationAccepted, false);
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

test('H20 — provider version or help changes invalidate the capability fingerprint', async (t) => {
  const item = await fixture(t, { version: 'codex-cli test-1' });
  const first = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  await fs.writeFile(item.controlPath, JSON.stringify({ version: 'codex-cli test-2', execHelpSuffix: 'new capability text' }), 'utf8');
  const second = await discoverProviderCapabilities({ providerCommand: item.providerCommand });
  assert.notEqual(first.fingerprint.capabilitiesHash, second.fingerprint.capabilitiesHash);
  assert.notEqual(first.fingerprint.providerVersion, second.fingerprint.providerVersion);
});
