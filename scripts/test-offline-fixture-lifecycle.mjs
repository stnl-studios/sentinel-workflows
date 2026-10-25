import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { allocateOfflineFixture, finishOfflineFixture, offlineSourceFilter } from './fixtures/offline-checkout.mjs';
import { copySnapshotDependencies } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';
import { assertOfflineSdk, describeOfflineSdk } from '../agents/codex/runtime/offline-provider-context.mjs';
import { persistAllocation } from '../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';

test('source copy excludes every node_modules subtree and measurements', () => {
  assert.equal(offlineSourceFilter('/project/agents/codex/node_modules'), false);
  assert.equal(offlineSourceFilter('/project/agents/codex/node_modules/sdk/file.mjs'), false);
  assert.equal(offlineSourceFilter('/project/benchmarks/sentinel-todo/measurements/latest.json'), false);
  assert.equal(offlineSourceFilter('/project/agents/codex/runtime/native-provider.mjs'), true);
});

test('offline snapshot uses the pinned real SDK read-only with identity and no dependency copy', async t => {
  const fixture = await allocateOfflineFixture();
  t.after(() => finishOfflineFixture(fixture));
  const source = await fs.realpath(path.resolve(import.meta.dirname, '../agents/codex/node_modules'));
  const snapshot = path.join(fixture.root, 'benchmark-temp/run-tiny/snapshot');
  const sdk = await describeOfflineSdk(source, fixture.root);
  const before = await Promise.all(sdk.files.map(file => fs.stat(path.join(source, file.path))));
  await assert.rejects(copySnapshotDependencies(snapshot, { dependencySource: source }), /restricted to OFFLINE_TEST_ONLY/u);
  await assert.rejects(copySnapshotDependencies(snapshot, { offlineSdk: sdk }), /restricted to OFFLINE_TEST_ONLY/u);
  assert.deepEqual(await copySnapshotDependencies(snapshot, { offlineSdk: sdk, executionMode: 'OFFLINE_TEST_ONLY' }),
    { sdkVersion: '0.163.0', cliVersion: '0.163.0', externalSdk: sdk });
  await assert.rejects(fs.lstat(snapshot), { code: 'ENOENT' });
  for (const mutate of [value => { value.sdkVersion = '0.0.0'; },
    value => { value.files[0].sha256 = 'sha256:' + '0'.repeat(64); },
    value => { value.entrypoint = path.join(source, 'other.js'); }]) {
    const altered = structuredClone(sdk); mutate(altered);
    await assert.rejects(assertOfflineSdk(altered, fixture.root), /integrity changed/u);
  }
  await assert.rejects(assertOfflineSdk({ ...sdk, fixtureRoot: '/wrong-fixture' }, fixture.root), /binding/u);
  await assert.rejects(describeOfflineSdk(path.join(fixture.root, 'missing'), fixture.root), { code: 'ENOENT' });
  assert.deepEqual(await describeOfflineSdk(source, fixture.root), sdk);
  const after = await Promise.all(sdk.files.map(file => fs.stat(path.join(source, file.path))));
  assert.deepEqual(after.map(stat => [stat.ino, stat.mode, stat.mtimeMs]), before.map(stat => [stat.ino, stat.mode, stat.mtimeMs]));
});

test('normal dependency snapshot reaches the copy branch and rejects either obsolete package version before copying', async t => {
  const fixture = await allocateOfflineFixture();
  t.after(() => finishOfflineFixture(fixture));
  const moduleFile = path.join(fixture.root, 'benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs');
  await fs.mkdir(path.dirname(moduleFile), { recursive: true });
  await fs.copyFile(path.resolve(import.meta.dirname, '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs'), moduleFile);
  const dependencies = path.join(fixture.root, 'agents/codex/node_modules');
  for (const name of ['codex-sdk', 'codex']) {
    await fs.mkdir(path.join(dependencies, '@openai', name), { recursive: true });
    await fs.writeFile(path.join(dependencies, '@openai', name, 'package.json'), JSON.stringify({ name: `@openai/${name}`, version: '0.163.0' }));
  }
  const { copySnapshotDependencies: copy } = await import(pathToFileURL(moduleFile));
  const destination = path.join(fixture.root, 'copied-snapshot');
  assert.deepEqual(await copy(destination), { sdkVersion: '0.163.0', cliVersion: '0.163.0' });
  for (const name of ['codex-sdk', 'codex']) {
    const source = path.join(dependencies, '@openai', name, 'package.json');
    assert.deepEqual(await fs.readFile(path.join(destination, 'agents/codex/node_modules/@openai', name, 'package.json')), await fs.readFile(source));
    await fs.writeFile(source, JSON.stringify({ name: `@openai/${name}`, version: '0.160.0' }));
    const rejected = path.join(fixture.root, `rejected-${name}`);
    await assert.rejects(copy(rejected), /version differs/u);
    await assert.rejects(fs.lstat(rejected), { code: 'ENOENT' });
    await fs.writeFile(source, JSON.stringify({ name: `@openai/${name}`, version: '0.163.0' }));
  }
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

test('collection racing an atomic allocation rename fails rather than omitting the transient source', async t => {
  const fixture = await allocateOfflineFixture();
  t.after(() => finishOfflineFixture(fixture));
  const directory = path.join(fixture.root, '.offline-atomic'); await fs.mkdir(directory);
  const marker = path.join(directory, 'owner.json'); await fs.writeFile(marker, '{"revision":1}');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const rename = fs.rename, lstat = fs.lstat;
  let temporary, writer, encountered = false;
  fs.rename = async (from, to) => {
    if (to === marker) { temporary = from; entered.resolve(); await release.promise; }
    return rename(from, to);
  };
  fs.lstat = async (file, ...args) => {
    if (file === temporary) { encountered = true; release.resolve(); await writer; }
    return lstat(file, ...args);
  };
  try {
    writer = persistAllocation(marker, { revision: 2 });
    await entered.promise;
    await assert.rejects(finishOfflineFixture(fixture), { code: 'ENOENT' });
    assert.equal(encountered, true, 'copy observed the temporary before its atomic rename');
    assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { revision: 2 });
    assert.equal((await lstat(fixture.root)).isDirectory(), true, 'failed collection retains the source fixture');
  } finally {
    release.resolve();
    try { await writer; }
    finally { fs.rename = rename; fs.lstat = lstat; }
  }
});
