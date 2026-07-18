import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildClosedCandidate, renderClosedFeature } from '../lib/closed-spec.mjs';
import { createReadinessAttestation } from '../lib/readiness.mjs';
import { validateCloseTransition, validateWorkspace } from '../lib/lifecycle.mjs';
import { copyFixture, FIXTURES, replace, RUNTIME_ROOT, snapshot, temporary } from './helpers.mjs';

function attestation(root, source, name = 'readiness.json') {
  return createReadinessAttestation(source, path.join(root, name), { scope: 'GLOBAL', verdict: 'READY' });
}

const OPTIONAL_SYMLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, 'EXDEV']);

test('renderer is byte-identical to the canonical golden and deterministic', () => {
  const source = path.join(FIXTURES, 'ready');
  const expected = fs.readFileSync(path.join(FIXTURES, 'closed', 'feature_spec.md'));
  assert.deepEqual(renderClosedFeature(source), expected);
  assert.deepEqual(renderClosedFeature(source), renderClosedFeature(source));
});

test('renderer preserves UTF-8, exact record bytes, ID gaps, and a final newline', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'unicode source');
  replace(path.join(source, 'feature_spec.md'), 'Provide deterministic invitation expiration behavior.', 'Preservar café, ação e 東京 deterministically.');
  for (const file of fs.readdirSync(path.join(source, 'shared')).map((name) => path.join(source, 'shared', name))) {
    let data = fs.readFileSync(file);
    for (const [before, after] of [['R-001', 'R-007'], ['AC-001', 'AC-004'], ['D-001', 'D-009'], ['C-001', 'C-003'], ['RK-001', 'RK-008'], ['Q-001', 'Q-006']]) data = Buffer.from(data.toString('utf8').replaceAll(before, after), 'utf8');
    fs.writeFileSync(file, data);
  }
  let feature = fs.readFileSync(path.join(source, 'feature_spec.md'), 'utf8');
  for (const [before, after] of [['R-001', 'R-007'], ['AC-001', 'AC-004'], ['D-001', 'D-009'], ['C-001', 'C-003'], ['RK-001', 'RK-008'], ['Q-001', 'Q-006']]) feature = feature.replaceAll(before, after);
  fs.writeFileSync(path.join(source, 'feature_spec.md'), feature);
  const questions = path.join(source, 'shared', 'questions.md');
  fs.writeFileSync(questions, fs.readFileSync(questions).toString('utf8').replace(/\n+$/u, ''));
  validateWorkspace(source);
  const rendered = renderClosedFeature(source);
  assert.match(rendered.toString('utf8'), /東京/u);
  assert.match(rendered.toString('utf8'), /### R-007/u);
  assert.equal(rendered.at(-1), 0x0a);
});

test('closed candidate preserves external regular files and excludes OS metadata', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source with externals');
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  const first = path.join(execution, 'payload-a.bin');
  fs.writeFileSync(first, Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(source, '.DS_Store'), 'ignored');
  const receipt = attestation(root, source);
  const candidate = buildClosedCandidate(source, path.join(root, 'closed candidate'), { readinessAttestation: receipt });
  assert.equal(validateWorkspace(candidate).closed, true);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'execution', 'payload-a.bin')), Buffer.from([0, 1, 255]));
  assert.equal(lexists(path.join(candidate, '.DS_Store')), false);
  validateCloseTransition(source, candidate);
});

test('closed candidate preserves external symlinks when symlinks are available', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source with symlink');
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  fs.writeFileSync(path.join(execution, 'payload-a.bin'), Buffer.from([0, 1, 255]));
  try {
    fs.symlinkSync('payload-a.bin', path.join(execution, 'payload-link'));
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error.code)) {
      t.skip(`symlinks unavailable on this filesystem (${error.code})`);
      return;
    }
    throw error;
  }
  const receipt = attestation(root, source);
  const candidate = buildClosedCandidate(source, path.join(root, 'closed symlink candidate'), { readinessAttestation: receipt });
  assert.equal(fs.readlinkSync(path.join(candidate, 'execution', 'payload-link')), 'payload-a.bin');
  validateCloseTransition(source, candidate);
});

test('closed candidate preserves external hardlink topology when hardlinks are available', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source with hardlinks');
  const execution = path.join(source, 'execution');
  const assets = path.join(source, 'assets');
  fs.mkdirSync(execution);
  fs.mkdirSync(assets);
  const first = path.join(execution, 'payload-a.bin');
  fs.writeFileSync(first, Buffer.from([0, 1, 255]));
  try {
    fs.linkSync(first, path.join(execution, 'payload-b.bin'));
    fs.linkSync(first, path.join(assets, 'payload-c.bin'));
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return;
    }
    throw error;
  }
  const receipt = attestation(root, source);
  const candidate = buildClosedCandidate(source, path.join(root, 'closed hardlink candidate'), { readinessAttestation: receipt });
  const linked = [path.join(candidate, 'execution', 'payload-a.bin'), path.join(candidate, 'execution', 'payload-b.bin'), path.join(candidate, 'assets', 'payload-c.bin')];
  assert.equal(new Set(linked.map((file) => `${fs.statSync(file).dev}:${fs.statSync(file).ino}`)).size, 1);
  validateCloseTransition(source, candidate);
});

function lexists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

test('stale receipts leave source and candidate untouched', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source');
  const receipt = attestation(root, source);
  const before = snapshot(source);
  replace(path.join(source, 'feature_spec.md'), 'Provide deterministic', 'Provide intentionally deterministic');
  validateWorkspace(source);
  assert.throws(() => buildClosedCandidate(source, path.join(root, 'stale candidate'), { readinessAttestation: receipt }), /stale/u);
  assert.equal(lexists(path.join(root, 'stale candidate')), false);
  assert.notDeepEqual(snapshot(source), before);
});

test('external hardlink boundary failures leave source and candidate untouched when hardlinks are available', (t) => {
  const root = temporary(t);
  const fresh = copyFixture(root, 'ready', 'hardlink boundary source');
  fs.mkdirSync(path.join(fresh, 'execution'));
  const outside = path.join(root, 'outside.bin');
  fs.writeFileSync(outside, 'outside');
  try {
    fs.linkSync(outside, path.join(fresh, 'execution', 'linked.bin'));
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return;
    }
    throw error;
  }
  const freshReceipt = attestation(root, fresh, 'hardlink.json');
  const freshBefore = snapshot(fresh);
  assert.throws(() => buildClosedCandidate(fresh, path.join(root, 'hardlink candidate'), { readinessAttestation: freshReceipt }), /crosses the CLOSE preservation boundary/u);
  assert.deepEqual(snapshot(fresh), freshBefore);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('renderer CLI works from unrelated cwd and preserves syntax exit code', (t) => {
  const root = temporary(t, 'stnl renderer cli ');
  const source = copyFixture(root, 'ready', 'source with spaces');
  const receipt = attestation(root, source);
  const cwd = path.join(root, 'outside cwd');
  fs.mkdirSync(cwd);
  const entry = path.join(RUNTIME_ROOT, 'build-closed-spec.mjs');
  const candidate = path.join(root, 'candidate with spaces');
  const success = spawnSync(process.execPath, [entry, source, candidate, '--readiness-attestation', receipt], { cwd, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'feature_spec.md')), fs.readFileSync(path.join(FIXTURES, 'closed', 'feature_spec.md')));
  const missing = spawnSync(process.execPath, [entry, source, path.join(root, 'missing')], { cwd, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--readiness-attestation/u);
});

test('renderer CLI accepts equals syntax and help exits successfully', (t) => {
  const root = temporary(t, 'stnl renderer grammar ');
  const source = copyFixture(root, 'ready', 'source');
  const receipt = attestation(root, source);
  const entry = path.join(RUNTIME_ROOT, 'build-closed-spec.mjs');
  const candidate = path.join(root, 'candidate');
  const equals = spawnSync(process.execPath, [entry, source, candidate, `--readiness-attestation=${receipt}`], { cwd: root, encoding: 'utf8' });
  assert.equal(equals.status, 0, equals.stderr);
  const help = spawnSync(process.execPath, [entry, '-h'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage:/u);
});
