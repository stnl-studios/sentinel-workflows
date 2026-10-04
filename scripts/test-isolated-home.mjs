import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareIsolatedHome, removeIsolatedHome, resumeIsolatedHome, suspendIsolatedHome,
  verifyIsolatedHome } from '../agents/codex/runtime/isolated-home.mjs';
import { codexClientConfig, runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'agents/codex/node_modules/@openai/codex/bin/codex.js');
const OPERATION_SKILLS = {
  SPEC_INIT: 'stnl-spec-lifecycle-manager', SPEC_READINESS: 'stnl-spec-lifecycle-manager',
  SPEC_RESUME: 'stnl-spec-lifecycle-manager', SPEC_PROMOTE: 'stnl-spec-lifecycle-manager',
  SPEC_CLOSE: 'stnl-spec-lifecycle-manager', PLAN: 'stnl-execution-planner', REPLAN: 'stnl-execution-planner',
  REVIEW_PLAN: 'stnl-plan-reviewer', MATERIALIZE_TASKS: 'stnl-task-materializer',
  REVIEW_TASKS: 'stnl-task-reviewer', EXECUTE_SLICE: 'stnl-slice-executor',
  APPLY_FINDINGS: 'stnl-slice-executor', VALIDATE_SLICE: 'stnl-slice-quality-manager',
};

test('home creation failure is recorded only before mkdtemp returns a directory', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-uncreated-home-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { runId: 'run-uncreated-test', caseId: 'A' };
  for (const name of ['snapshot', 'workspace', 'candidates', 'tmpdir']) {
    input[name] = path.join(root, name); await fs.mkdir(input[name]);
  }
  const authPath = path.join(root, 'fixture-auth.json');
  await fs.writeFile(authPath, '{}');
  const failure = Object.assign(new Error('fixture denied allocation'), { code: 'EPERM' });
  t.mock.method(fs, 'mkdtemp', async () => { throw failure; });
  await assert.rejects(prepareIsolatedHome(input, { authPath }), (error) =>
    error === failure && error.code === 'EPERM' && error.privateHomeNotCreated === true);
  t.mock.restoreAll();
  const allocated = path.join(root, 'allocated'); await fs.mkdir(allocated);
  t.mock.method(fs, 'mkdtemp', async () => allocated);
  const laterFailure = Object.assign(new Error('fixture denied setup after allocation'), { code: 'EPERM' });
  t.mock.method(fs, 'chmod', async () => { throw laterFailure; });
  await assert.rejects(prepareIsolatedHome(input, { authPath }), (error) =>
    error === laterFailure && error.privateHomeNotCreated === undefined);
  t.mock.restoreAll();
  assert.equal((await fs.stat(allocated)).isDirectory(), true, 'partial creation stays visible and ambiguous');
});

async function fixture(t) {
  await fs.mkdir(path.join(os.homedir(), 'Library', 'Application Support'), { recursive: true });
  await fs.mkdir(path.join(ROOT, 'benchmark-temp'), { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(ROOT, 'benchmark-temp/isolated-home-test-')));
  const input = { runId: 'test-' + randomUUID().replaceAll('-', ''), caseId: 'A',
    snapshot: path.join(root, 'snapshot'), workspace: path.join(root, 'workspace'),
    candidates: path.join(root, 'candidates'), tmpdir: path.join(root, 'tmp') };
  for (const directory of [input.snapshot, input.workspace, input.candidates, input.tmpdir]) await fs.mkdir(directory);
  const authPath = path.join(root, 'source-auth.json');
  await fs.writeFile(authPath, '{"auth_mode":"chatgpt"}', { mode: 0o600 });
  for (const name of new Set(Object.values(OPERATION_SKILLS))) {
    const directory = path.join(input.snapshot, 'skills', 'workflows', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: ' + name
      + '\ndescription: Offline ' + name + ' fixture.\n---\nSnapshot instructions.\n');
  }
  await fs.mkdir(path.join(input.snapshot, 'agents', 'codex', 'runtime'), { recursive: true });
  const home = await prepareIsolatedHome(input, { authPath });
  t.after(async () => {
    await removeIsolatedHome(home, input);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, input, authPath, home };
}

function inside(file, parent) {
  const relative = path.relative(parent, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function promptCatalog(home, overrides, workspace) {
  const result = spawnSync(process.execPath, [CLI, ...overrides.flatMap((value) => ['-c', value]),
    'debug', 'prompt-input', 'offline'], {
    env: home.env, cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).flatMap((message) => message.content ?? []).map((content) => content.text ?? '')
    .filter((text) => text.includes('<skills_instructions>')).join('\n');
}

test('fresh author and review threads receive snapshot-provenance skills with Full Access through the real SDK', async (t) => {
  const { root, input, home } = await fixture(t);
  const config = await fs.readFile(path.join(home.privateHome, 'config.toml'), 'utf8');
  assert.match(config, /^sandbox_mode = "danger-full-access"$/mu);
  assert.match(config, /^approval_policy = "never"$/mu);
  assert.doesNotMatch(config, /default_permissions|\[permissions\./u);
  assert.equal((await fs.stat(path.join(home.privateHome, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal(await fs.lstat(path.join(home.privateHome, 'skills')).catch(() => null), null);
  const main = await codexClientConfig({ env: home.env });
  assert.equal(main.skills.bundled.enabled, false);
  for (const skill of main.skills.config) {
    assert.equal(skill.enabled, true);
    assert.equal(inside(skill.path, home.privateHome), false);
    const snapshotPath = path.join(input.snapshot, 'skills', 'workflows', path.basename(path.dirname(skill.path)), 'SKILL.md');
    assert.deepEqual(await fs.readFile(skill.path), await fs.readFile(snapshotPath));
    assert.equal((await fs.stat(skill.path)).mode & 0o222, 0);
  }
  assert.equal(home.skillsSha256, home.snapshotSkillsSha256);

  const fakeCli = path.join(root, 'fake-codex.mjs');
  const capture = path.join(root, 'calls.jsonl');
  await fs.writeFile(fakeCli, '#!' + process.execPath + "\nimport fs from 'node:fs';\n"
    + "fs.appendFileSync(process.env.STNL_FAKE_CLI_CAPTURE, JSON.stringify(process.argv.slice(2))+'\\n');\n"
    + "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-offline'}));\n"
    + "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));\n");
  await fs.chmod(fakeCli, 0o755);
  const env = { ...home.env, STNL_FAKE_CLI_CAPTURE: capture };
  const turnInput = { env, cwd: input.workspace, prompt: 'offline', model: 'gpt-6-luna', effort: 'medium', codexPathOverride: fakeCli };
  for (const operation of Object.keys(OPERATION_SKILLS)) {
    const turn = await runCodexTurn({ ...turnInput, operationId: operation, eventsPath: path.join(root, operation + '.jsonl') });
    assert.equal(turn.completed, true, turn.error);
  }
  const runner = await runCodexTurn({ ...turnInput,
    developerInstructions: 'Independent offline runner contract.', isolateSkills: true,
    operationId: 'runner', eventsPath: path.join(root, 'runner.jsonl') });
  assert.equal(runner.completed, true, runner.error);
  const resumed = await runCodexTurn({ ...turnInput,
    threadId: 'thread-offline', operationId: 'resumed', eventsPath: path.join(root, 'resumed.jsonl') });
  assert.equal(resumed.completed, true, resumed.error);
  const calls = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  const overrides = (args) => args.filter((_value, index) => args[index - 1] === '--config');
  for (const [index, [operation, name]] of Object.entries(OPERATION_SKILLS).entries()) {
    assert.equal(calls[index][calls[index].indexOf('--sandbox') + 1], 'danger-full-access');
    assert.equal(calls[index].includes('resume'), false, operation + ' must represent a fresh thread');
    const values = overrides(calls[index]);
    assert.deepEqual(values, overrides(calls[0]));
    assert.ok(values.some((value) => value.startsWith('skills.config=') && value.includes(name + '/SKILL.md') && /enabled\s*=\s*true/u.test(value)));
  }
  assert.ok(calls.at(-1).includes('resume'));
  assert.deepEqual(overrides(calls.at(-1)), overrides(calls[0]));
  const catalog = promptCatalog(home, overrides(calls[0]), input.workspace);
  for (const name of new Set(Object.values(OPERATION_SKILLS))) assert.ok(catalog.includes(name + '/SKILL.md'));
  assert.ok(catalog.includes(path.join(home.env.HOME, '.agents', 'skills')));
  assert.equal(catalog.includes(home.privateHome), false);
  assert.equal(promptCatalog(home, overrides(calls.at(-2)), input.workspace), '');
});

test('suspend/resume preserves native skill provenance and rejects tampered snapshot or operational copy', async (t) => {
  const { input, authPath, home } = await fixture(t);
  const runCommand = (_command, args) => args[0] === 'login'
    ? { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
    : { status: 0, stdout: JSON.stringify({ checks: {
      'auth.credentials': { details: { 'stored auth mode': 'chatgpt', 'stored API key': 'false' } },
      'config.load': { details: { 'model provider': 'openai' } },
      'sandbox.helpers': { details: { 'filesystem sandbox': 'unrestricted', 'network sandbox': 'enabled',
        'approval policy': 'Never', 'denied-read rules': '0', 'denied-read glob rules': '0' } },
    } }), stderr: '' };
  assert.deepEqual(await verifyIsolatedHome(home, { runCommand }), {
    authMode: 'chatgpt', provider: 'openai', filesystemSandbox: 'unrestricted', sandboxMode: 'danger-full-access',
  });
  const before = await codexClientConfig({ env: home.env });
  const suspended = await suspendIsolatedHome(home, input, {
    runCommand: () => ({ status: 1, stdout: '', stderr: 'Not logged in' }),
  });
  assert.equal(await fs.lstat(path.join(home.privateHome, 'auth.json')).catch(() => null), null);
  const copy = path.join(home.shellHome, '.agents', 'skills', 'stnl-plan-reviewer', 'SKILL.md');
  const source = path.join(input.snapshot, 'skills', 'workflows', 'stnl-plan-reviewer', 'SKILL.md');
  const bytes = await fs.readFile(source);
  for (const file of [source, copy]) {
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, 'tampered');
    await assert.rejects(resumeIsolatedHome({ ...input, suspended }, { authPath }), /changed/u);
    assert.equal(await fs.lstat(path.join(home.privateHome, 'auth.json')).catch(() => null), null);
    await fs.writeFile(file, bytes);
    await fs.chmod(file, 0o444);
  }
  const resumed = await resumeIsolatedHome({ ...input, suspended }, { authPath });
  assert.deepEqual(resumed.env, home.env);
  assert.deepEqual(await codexClientConfig({ env: resumed.env }), before);
  assert.equal(resumed.snapshotSkillsSha256, home.snapshotSkillsSha256);
  assert.equal((await fs.stat(path.join(home.privateHome, 'auth.json'))).mode & 0o777, 0o600);
  await fs.appendFile(path.join(home.privateHome, 'config.toml'), '\n# tampered\n');
  await assert.rejects(verifyIsolatedHome(resumed, { runCommand }), /config changed/u);
});
