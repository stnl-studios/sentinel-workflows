import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareIsolatedHome, removeIsolatedHome, suspendIsolatedHome, verifyIsolatedHome } from '../agents/codex/runtime/isolated-home.mjs';

const PRIVATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support');
test('isolated home accepts CLI skill state while retaining auth, config, suspension, and cleanup guards', async (t) => {
  await fs.mkdir(PRIVATE_PARENT, { recursive: true });
  const runId = `test-${randomUUID().replaceAll('-', '')}`;
  const caseId = 'A';
  const snapshot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-isolated-snapshot-')));
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-isolated-workspace-')));
  const candidates = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-isolated-candidates-')));
  const tmpdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-isolated-tmp-')));
  const authPath = path.join(tmpdir, 'source-auth.json');
  await fs.writeFile(authPath, '{"auth_mode":"chatgpt"}', { mode: 0o600 });
  await fs.mkdir(path.join(snapshot, 'skills', 'workflows', 'stnl-example'), { recursive: true });
  await fs.writeFile(path.join(snapshot, 'skills', 'workflows', 'stnl-example', 'SKILL.md'), 'snapshot skill');
  await fs.mkdir(path.join(snapshot, 'agents', 'codex', 'runtime'), { recursive: true });
  const identity = { runId, caseId };
  let home;
  t.after(async () => {
    await fs.rm(snapshot, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(candidates, { recursive: true, force: true });
    await fs.rm(tmpdir, { recursive: true, force: true });
    if (home) await removeIsolatedHome(home, identity).catch(() => {});
  });
  home = await prepareIsolatedHome({ ...identity, snapshot, workspace, candidates, tmpdir }, { authPath });
  const config = await fs.readFile(path.join(home.privateHome, 'config.toml'), 'utf8');
  const permissions = config.slice(config.indexOf('[permissions.sentinel-case.filesystem]'), config.indexOf('[projects.'));
  assert.match(permissions, /"\." = "write"/u);
  assert.match(permissions, /\/skills" = "read"/u);
  assert.match(config, /approval_policy = "never"/u);
  assert.match(config, /agents\]\nenabled = false/u);
  assert.equal((await fs.stat(path.join(home.privateHome, 'auth.json'))).mode & 0o777, 0o600);

  await fs.mkdir(path.join(home.privateHome, 'skills', '.system', 'cache'), { recursive: true });
  await fs.writeFile(path.join(home.privateHome, 'skills', '.system', 'cache', 'state.json'), '{"lastUsed":1}');
  await fs.writeFile(path.join(home.privateHome, 'skills', 'stnl-example', 'SKILL.md'), 'CLI-updated skill');
  const runCommand = (_command, args) => args[0] === 'login'
    ? { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
    : { status: 0, stdout: JSON.stringify({ checks: {
      'auth.credentials': { details: { 'stored auth mode': 'chatgpt', 'stored API key': 'false' } },
      'config.load': { details: { 'model provider': 'openai' } },
      'sandbox.helpers': { details: { 'filesystem sandbox': 'restricted' } },
    } }), stderr: '' };
  assert.deepEqual(await verifyIsolatedHome(home, { runCommand }), {
    authMode: 'chatgpt', provider: 'openai', filesystemSandbox: 'restricted',
  });

  const suspended = await suspendIsolatedHome(home, identity, {
    runCommand: () => ({ status: 1, stdout: '', stderr: 'Not logged in' }),
  });
  assert.equal(await fs.lstat(path.join(home.privateHome, 'auth.json')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(home.privateHome, 'skills', '.system', 'cache', 'state.json'), 'utf8'), '{"lastUsed":1}');
  await removeIsolatedHome(suspended, identity);
  home = null;
  assert.equal(await fs.lstat(suspended.privateHome).catch(() => null), null);
});
