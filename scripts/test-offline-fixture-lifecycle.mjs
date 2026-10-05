import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { allocateOfflineFixture, finishOfflineFixture, offlineSourceFilter } from './fixtures/offline-checkout.mjs';
import { copySnapshotDependencies } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';

test('source copy excludes every node_modules subtree and measurements', () => {
  assert.equal(offlineSourceFilter('/project/agents/codex/node_modules'), false);
  assert.equal(offlineSourceFilter('/project/agents/codex/node_modules/sdk/file.mjs'), false);
  assert.equal(offlineSourceFilter('/project/benchmarks/sentinel-todo/measurements/latest.json'), false);
  assert.equal(offlineSourceFilter('/project/agents/codex/runtime/sdk-transport.mjs'), true);
});

test('tiny dependency source is copied only into the owned snapshot; production overrides are refused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-tiny-dependencies-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'source'));
  const source = await fs.realpath(path.join(root, 'source')), snapshot = path.join(root, 'snapshot');
  for (const name of ['codex-sdk', 'codex']) {
    await fs.mkdir(path.join(source, '@openai', name), { recursive: true });
    await fs.writeFile(path.join(source, '@openai', name, 'package.json'), '{"version":"0.160.0"}\n');
  }
  const bytes = Buffer.from('tiny dependency bytes\n');
  const file = path.join(source, '@openai/codex/tiny.bin');
  await fs.writeFile(file, bytes);
  const mode = (await fs.stat(file)).mode;
  await assert.rejects(copySnapshotDependencies(snapshot, { dependencySource: source }), /restricted to OFFLINE_TEST_ONLY/u);
  assert.deepEqual(await copySnapshotDependencies(snapshot, { dependencySource: source, executionMode: 'OFFLINE_TEST_ONLY' }),
    { sdkVersion: '0.160.0', cliVersion: '0.160.0' });
  const target = path.join(snapshot, 'agents/codex/node_modules/@openai/codex/tiny.bin');
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await fs.stat(target)).nlink, 1);
  await fs.chmod(target, 0o400);
  assert.equal((await fs.stat(file)).mode, mode, 'freezing the copy cannot change the shared source');
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('closed owned fixture preserves hashed evidence and drops dependencies and checkout after use', async t => {
  const fixture = await allocateOfflineFixture();
  const run = path.join(fixture.root, 'benchmark-temp/run-tiny');
  await fs.mkdir(path.join(run, 'snapshot/agents/codex/node_modules'), { recursive: true });
  await fs.writeFile(path.join(run, 'snapshot/agents/codex/node_modules/tiny.bin'), 'omit');
  await fs.writeFile(path.join(run, 'run.json'), '{"status":"BLOCKED"}');
  await fs.writeFile(path.join(run, 'summary.json'), '{"status":"BLOCKED"}');
  const bytes = Buffer.from('original diagnostic\n');
  await fs.writeFile(path.join(fixture.root, '.offline-example.log'), bytes);
  await fs.chmod(path.join(run, 'snapshot/agents/codex/node_modules'), 0o500);
  const archive = await finishOfflineFixture(fixture);
  t.after(() => fs.rm(archive, { recursive: true, force: true }));
  assert.deepEqual(await fs.readFile(path.join(archive, '.offline-example.log')), bytes);
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'evidence-manifest.json')));
  assert.equal(manifest.files.find(file => file.path === '.offline-example.log').sha256,
    createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(fs.lstat(path.join(archive, 'benchmark-temp/run-tiny/snapshot/agents/codex/node_modules')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(fixture.root), { code: 'ENOENT' });
  await assert.rejects(finishOfflineFixture(fixture), /not allocated by this process/u);
});

test('active manager and recorded live process retain the tiny fixture', async t => {
  const fixture = await allocateOfflineFixture();
  const runs = path.join(fixture.root, 'benchmark-temp'); await fs.mkdir(runs);
  const active = path.join(runs, '.active-run.json');
  t.after(async () => { await fs.rm(active, { force: true }); await fs.rm(path.join(fixture.root, '.offline-calls.jsonl'), { force: true }); await finishOfflineFixture(fixture); });
  await fs.writeFile(active, JSON.stringify({ pid: process.pid }));
  await assert.rejects(finishOfflineFixture(fixture), /active or interrupted manager/u);
  await fs.unlink(active);
  await fs.writeFile(path.join(fixture.root, '.offline-calls.jsonl'), JSON.stringify({ pid: process.pid, managerPid: process.pid }) + '\n');
  await assert.rejects(finishOfflineFixture(fixture), /still alive/u);
  assert.equal((await fs.stat(fixture.root)).isDirectory(), true);
});

test('shared fixture archives at its first consumer and removes only after the final consumer', async t => {
  const fixture = await allocateOfflineFixture();
  await fs.writeFile(path.join(fixture.root, '.offline-shared.log'), 'first consumer');
  const first = await finishOfflineFixture(fixture, { remove: false });
  assert.equal((await fs.stat(fixture.root)).isDirectory(), true);
  await fs.writeFile(path.join(fixture.root, '.offline-shared.log'), 'final consumer');
  const final = await finishOfflineFixture(fixture);
  t.after(() => Promise.all([first, final].map(root => fs.rm(root, { recursive: true, force: true }))));
  assert.equal(await fs.readFile(path.join(first, '.offline-shared.log'), 'utf8'), 'first consumer');
  assert.equal(await fs.readFile(path.join(final, '.offline-shared.log'), 'utf8'), 'final consumer');
  await assert.rejects(fs.lstat(fixture.root), { code: 'ENOENT' });
});

test('foreign objects and changed ownership cannot delete an existing fixture', async t => {
  const fixture = await allocateOfflineFixture();
  const marker = path.join(fixture.root, '.offline-fixture-owner.json'), before = await fs.readFile(marker);
  t.after(async () => { await fs.writeFile(marker, before); await finishOfflineFixture(fixture); });
  await assert.rejects(finishOfflineFixture({ root: fixture.root }), /not allocated by this process/u);
  await fs.writeFile(marker, '{}');
  await assert.rejects(finishOfflineFixture(fixture), /ownership changed/u);
  assert.equal((await fs.stat(fixture.root)).isDirectory(), true);
});

test('an unsettled case prevents removal even with a terminal run summary', async t => {
  const fixture = await allocateOfflineFixture();
  const run = path.join(fixture.root, 'benchmark-temp/run-tiny'), selected = path.join(run, 'case-a');
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(run, 'run.json'), '{"status":"BLOCKED"}');
  await fs.writeFile(path.join(run, 'summary.json'), '{"status":"BLOCKED"}');
  const state = path.join(selected, 'case-state.json');
  await fs.writeFile(state, '{"status":"ACTIVE"}');
  t.after(async () => { await fs.writeFile(state, '{"status":"BLOCKED"}'); await finishOfflineFixture(fixture); });
  await assert.rejects(finishOfflineFixture(fixture), /case is not settled/u);
  assert.equal((await fs.stat(fixture.root)).isDirectory(), true);
});

test('archive failure retains original evidence and the complete owned fixture', async t => {
  const fixture = await allocateOfflineFixture();
  const log = path.join(fixture.root, '.offline-error.log');
  await fs.writeFile(log, 'must survive');
  const original = fs.writeFile;
  fs.writeFile = async (file, ...args) => {
    if (String(file).includes('/stnl-offline-evidence-') && String(file).endsWith('/.offline-error.log')) {
      throw Object.assign(new Error('TEST-ONLY archive fault'), { code: 'EIO' });
    }
    return original(file, ...args);
  };
  try { await assert.rejects(finishOfflineFixture(fixture), { code: 'EIO' }); }
  finally { fs.writeFile = original; }
  t.after(() => finishOfflineFixture(fixture));
  assert.equal(await fs.readFile(log, 'utf8'), 'must survive');
});
