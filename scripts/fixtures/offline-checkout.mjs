import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OFFLINE_AUTH, OFFLINE_MARKER, OFFLINE_PROVIDER } from '../../agents/codex/runtime/offline-provider-context.mjs';

const owned = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const optional = async file => fs.readFile(file, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid fixture process identity');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
export const offlineSourceFilter = file => !file.split(path.sep).some(part => ['node_modules', '.DS_Store', 'measurements'].includes(part));

// Only allocations made in this process are eligible; no adoption or backlog scan.
export async function allocateOfflineFixture(repository = null) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/stnl-offline-checkout-'));
  const fixture = { root };
  const owner = { root, id: randomUUID(), pid: process.pid, inode: (await fs.lstat(root)).ino };
  if (repository !== null) {
    const clone = spawnSync('git', ['clone', '--no-hardlinks', '--local', repository, root], { encoding: 'utf8', timeout: 30_000 });
    if (clone.status !== 0) {
      if (await fs.realpath(root) === root && (await fs.lstat(root)).ino === owner.inode) await fs.rm(root, { recursive: true });
      assert.equal(clone.status, 0, clone.stderr);
    }
  }
  await fs.writeFile(path.join(root, '.offline-owned'), OFFLINE_MARKER, { flag: 'wx' });
  await fs.writeFile(path.join(root, '.offline-fixture-owner.json'), JSON.stringify(owner), { flag: 'wx' });
  owned.set(fixture, owner);
  return fixture;
}

export async function createOfflineCheckout(t, repository, scenario, { shared = false, config = '# fictitious GLOBAL sentinel\n' } = {}) {
  const fixture = await allocateOfflineFixture(repository);
  t.after(() => finishOfflineFixture(fixture, { remove: !shared }));
  const root = fixture.root;
  for (const name of ['agents', 'skills', 'scripts', 'templates', 'benchmarks']) await fs.cp(path.join(repository, name), path.join(root, name), {
    recursive: true, filter: offlineSourceFilter,
  });
  const home = path.join(root, '.offline-home');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(home, 'Library/Application Support'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/auth.json'), OFFLINE_AUTH);
  await fs.writeFile(path.join(home, '.codex/config.toml'), config);
  await fs.writeFile(path.join(home, '.claude/settings.json'), '{"fictitious":"unchanged"}\n');
  await fs.writeFile(path.join(root, '.offline-context.json'), JSON.stringify({ mode: 'OFFLINE_TEST_ONLY', root, home, scenario,
    dependencySource: await fs.realpath(path.join(repository, 'agents/codex/node_modules')),
    providerSha256: 'sha256:' + hash(await fs.readFile(path.join(root, OFFLINE_PROVIDER))) }));
  const env = { ...process.env, HOME: home, STNL_OFFLINE_PROVIDER_CONTEXT: path.join(root, '.offline-context.json'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '1',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  Object.assign(fixture, { home, env });
  return fixture;
}

export async function finishOfflineFixture(fixture, { remove = true } = {}) {
  const owner = owned.get(fixture);
  async function assertOwnership() {
    if (!owner || fixture.root !== owner.root || await fs.realpath(owner.root) !== owner.root
      || (await fs.lstat(owner.root)).ino !== owner.inode
      || await fs.readFile(path.join(owner.root, '.offline-owned'), 'utf8') !== OFFLINE_MARKER
      || JSON.stringify(await optional(path.join(owner.root, '.offline-fixture-owner.json'))) !== JSON.stringify(owner)) {
      throw new Error('OFFLINE_FIXTURE_RETAINED: ownership changed or fixture was not allocated by this process');
    }
  }
  await assertOwnership();
  const root = owner.root;
  if (await optional(path.join(root, 'benchmark-temp/.active-run.json')) !== null) throw new Error('OFFLINE_FIXTURE_RETAINED: active or interrupted manager');
  const runNames = await fs.readdir(path.join(root, 'benchmark-temp')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const name of runNames.filter(name => name.startsWith('run-'))) {
    const runRoot = path.join(root, 'benchmark-temp', name);
    const info = await optional(path.join(runRoot, 'run.json'));
    const summary = await optional(path.join(runRoot, 'summary.json'));
    if (!info || !summary || !['PASS', 'BLOCKED', 'CANCELLED'].includes(info.status) || info.status !== summary.status) {
      throw new Error('OFFLINE_FIXTURE_RETAINED: run is not demonstrably terminal');
    }
    for (const entry of await fs.readdir(runRoot, { withFileTypes: true })) if (entry.isDirectory() && /^case-[abc]$/u.test(entry.name)) {
      const state = await optional(path.join(runRoot, entry.name, 'case-state.json'));
      if (!state || !['PASS', 'BLOCKED', 'CANCELLED'].includes(state.status)
        || state.privateHomeSuspended || state.privateHomeCleanupError) throw new Error('OFFLINE_FIXTURE_RETAINED: case is not settled');
      if (await optional(path.join(runRoot, entry.name, 'tmp/stnl-runner-broker/active.json')) !== null) throw new Error('OFFLINE_FIXTURE_RETAINED: broker still active');
    }
  }
  const calls = await fs.readFile(path.join(root, '.offline-calls.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const pids = new Set(calls.split('\n').filter(Boolean).flatMap(line => {
    const call = JSON.parse(line); return [call.pid, call.managerPid];
  }));
  for (const name of await fs.readdir(root)) if (/^\.offline-(?:bridge-pid|runner-ready|sibling-ready-[BC])$/u.test(name)) {
    pids.add(Number(await fs.readFile(path.join(root, name), 'utf8')));
  }
  if ([...pids].some(alive)) throw new Error('OFFLINE_FIXTURE_RETAINED: recorded fixture process is still alive');

  const archive = await fs.realpath(await fs.mkdtemp('/tmp/stnl-offline-evidence-'));
  const manifest = { originalRoot: root, ownerId: owner.id, dependenciesOmitted: true, files: [] };
  async function copy(relative) {
    if (['node_modules', '.git', '.offline-home'].includes(path.basename(relative))) return;
    const source = path.join(root, relative), target = path.join(archive, relative);
    const metadata = await fs.lstat(source);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await fs.mkdir(target, { recursive: true });
      for (const name of (await fs.readdir(source)).sort()) await copy(path.join(relative, name));
    } else {
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('OFFLINE_FIXTURE_RETAINED: non-regular evidence');
      const bytes = await fs.readFile(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
      if (hash(await fs.readFile(target)) !== hash(bytes)) throw new Error('OFFLINE_FIXTURE_RETAINED: archive verification failed');
      manifest.files.push({ path: relative, size: bytes.length, mode: metadata.mode & 0o777, sha256: hash(bytes) });
    }
  }
  for (const name of (await fs.readdir(root)).sort()) {
    if (name.startsWith('.offline-') || name === 'benchmark-temp') await copy(name);
  }
  const measurements = path.join(root, 'benchmarks/sentinel-todo/measurements');
  if (await fs.lstat(measurements).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) {
    await copy('benchmarks/sentinel-todo/measurements');
  }
  await fs.writeFile(path.join(archive, 'evidence-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`TEST-ONLY archived fixture evidence: ${archive}`);
  if (remove) {
    await assertOwnership();
    // Thaw only directories of this closed owned fixture, never the shared SDK.
    async function thaw(directory) {
      const metadata = await fs.lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('OFFLINE_FIXTURE_RETAINED: unsafe directory');
      await fs.chmod(directory, (metadata.mode & 0o777) | 0o200);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await thaw(path.join(directory, entry.name));
    }
    await thaw(root);
    await fs.rm(root, { recursive: true });
    owned.delete(fixture);
  }
  return archive;
}
