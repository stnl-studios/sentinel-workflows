#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cleanupManagedBenchmarkSession,
  createManagedBenchmarkSession,
} from '../benchmarks/sentinel-todo/runtime/benchmark-environment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'runtime', 'benchmark.mjs');
const SEED = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'seed');

function runDoctor(args = []) {
  return spawnSync(process.execPath, [RUNTIME, 'doctor', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
}

function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function treeHash(root) {
  const digest = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !['.DS_Store', '__MACOSX'].includes(entry.name) && !entry.name.startsWith('._'))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        digest.update(childRelative.split(path.sep).join('/'));
        digest.update('\0');
        digest.update(await fs.readFile(child));
        digest.update('\0');
      }
    }
  }
  await visit(root);
  return digest.digest('hex');
}

function parseReady(result) {
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), [
    'status', 'contractVersion', 'platform', 'arch', 'nodeVersion', 'gitVersion',
    'checks', 'globalGitConfigPreserved', 'blockers',
  ]);
  assert.equal(report.status, 'ENVIRONMENT_READY');
  assert.equal(report.contractVersion, 1);
  assert.equal(report.globalGitConfigPreserved, true);
  assert.deepEqual(report.blockers, []);
  for (const value of Object.values(report.checks)) assert.ok(['PASS', 'NOT_APPLICABLE'].includes(value));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(ROOT), false);
  assert.equal(serialized.includes(os.homedir()), false);
  assert.equal(serialized.includes(os.tmpdir()), false);
  return report;
}

function stableFingerprint(report) {
  return {
    contractVersion: report.contractVersion,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    gitVersion: report.gitVersion,
    checks: report.checks,
    globalGitConfigPreserved: report.globalGitConfigPreserved,
  };
}

test('E01 — doctor runs twice with an identical stable fingerprint', () => {
  const first = parseReady(runDoctor());
  const second = parseReady(runDoctor());
  assert.deepEqual(stableFingerprint(first), stableFingerprint(second));
});

test('E02 — caller scratch parent supports spaces and Unicode without residue', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark parent ü ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  parseReady(runDoctor(['--scratch-parent', root]));
  assert.deepEqual(await fs.readdir(root), []);
});

test('E03 — unsafe, missing, symlink, and malformed scratch inputs fail closed', async (t) => {
  assert.equal(runDoctor(['--scratch-parent', path.join(ROOT, 'benchmarks')]).status, 2);
  const missing = path.join(os.tmpdir(), `sentinel-environment-missing-${process.pid}`);
  await fs.rm(missing, { recursive: true, force: true });
  assert.equal(runDoctor(['--scratch-parent', missing]).status, 2);

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark symlink parent ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await fs.mkdir(target);
  await fs.symlink(target, link, 'dir');
  assert.equal(runDoctor(['--scratch-parent', link]).status, 2);
  assert.equal(runDoctor(['--unknown', 'value']).status, 2);
  assert.equal(runDoctor(['--scratch-parent']).status, 2);
});

test('E04 — doctor preserves checkout and benchmark seed bytes', async () => {
  const statusBefore = gitStatus();
  const seedBefore = await treeHash(SEED);
  parseReady(runDoctor());
  assert.equal(gitStatus(), statusBefore);
  assert.equal(await treeHash(SEED), seedBefore);
});

test('E05 — exported session ownership supplies the harness layout and bounded cleanup', async () => {
  const session = await createManagedBenchmarkSession({ repositoryRoot: ROOT });
  assert.equal(path.dirname(session.workspaces), session.root);
  assert.equal(path.dirname(session.runnerTmp), session.root);
  assert.equal(path.basename(session.workspaces), 'workspaces');
  assert.equal(path.basename(session.runnerTmp), 'runner-tmp');
  await cleanupManagedBenchmarkSession(session);
  await assert.rejects(fs.access(session.root));
  await assert.rejects(cleanupManagedBenchmarkSession(session), /not owned/u);
});
