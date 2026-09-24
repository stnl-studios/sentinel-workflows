import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideOutcome, nextHandoff } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MANAGER = path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');

function invoke(...args) {
  return spawnSync(process.execPath, [MANAGER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function ownedRun(t) {
  const id = `run-test-${randomUUID()}`;
  const root = path.join(RUNS, id);
  await fs.mkdir(root, { recursive: true });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ status: 'PASS', cases: { A: { status: 'PASS' } } }));
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ status: 'PASS', mode: 'case', snapshot: {
    snapshotSha256: 'snapshot', sourceFunctionalSha256: 'source',
  } }));
  return { id, root };
}

test('COMPLETE requires one terminal global readiness before lifecycle close', () => {
  const readback = { lifecycle: { status: 'ready' }, execution: { state: 'COMPLETE' },
    executionRaw: { state: 'COMPLETE' } };
  assert.deepEqual(nextHandoff('VALIDATE_SLICE', readback), { operation: 'SPEC_READINESS', slice: null });
  assert.deepEqual(decideOutcome('SPEC_READINESS', readback, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_READINESS', readback), { operation: 'SPEC_CLOSE', slice: null });
  assert.equal(nextHandoff('SPEC_CLOSE', readback), null);
  assert.deepEqual(decideOutcome('SPEC_READINESS', {
    lifecycle: { status: 'ready' }, execution: { state: 'EMPTY' }, executionRaw: { state: 'EMPTY' },
  }, true), { result: 'PASS', blocker: null });
});

test('status and inspect are read only and clean removes only the selected owned run', async (t) => {
  const { id, root } = await ownedRun(t);
  const other = await ownedRun(t);
  const caseRoot = path.join(root, 'case-a');
  await fs.mkdir(caseRoot);
  await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({
    status: 'PASS', privateHomeRemoved: true, operations: [], terminal: { result: 'PASS' },
  }));
  const status = invoke('status', '--run', id);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).status, 'PASS');
  const inspected = invoke('inspect', '--run', id, '--case', 'A');
  assert.equal(inspected.status, 0);
  assert.equal(JSON.parse(inspected.stdout).cases.A.status, 'PASS');
  assert.equal((await fs.readdir(root)).includes('summary.json'), true);
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  assert.equal((await fs.lstat(other.root)).isDirectory(), true);
});

test('clean refuses a symlink in an owned run and leaves evidence intact', async (t) => {
  const { id, root } = await ownedRun(t);
  await fs.symlink(path.join(ROOT, 'README.md'), path.join(root, 'escape'));
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /contains a symlink/u);
  assert.equal((await fs.lstat(path.join(root, 'summary.json'))).isFile(), true);
});
