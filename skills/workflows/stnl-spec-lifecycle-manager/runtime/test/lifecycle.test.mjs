import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  ValidationError,
  resumeWorkspaceIdentity,
  validateCloseTransition,
  validateInitTransition,
  validateReadinessTransition,
  validateResumeTransition,
  validateWorkspace,
  workspaceSnapshot,
} from '../lib/lifecycle.mjs';
import { copyFixture, replace, RUNTIME_ROOT, temporary } from './helpers.mjs';

test('validates active, blocked, and closed canonical fixtures', () => {
  const ready = validateWorkspace(path.join(RUNTIME_ROOT, '..', 'examples', 'validator-fixtures', 'ready'));
  const blocked = validateWorkspace(path.join(RUNTIME_ROOT, '..', 'examples', 'validator-fixtures', 'blocked'));
  const closed = validateWorkspace(path.join(RUNTIME_ROOT, '..', 'examples', 'validator-fixtures', 'closed'));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.items.size, 6);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.items.size, 3);
  assert.equal(closed.closed, true);
  assert.equal(closed.items.size, 6);
});

test('workspace validation rejects broken references without mutation', (t) => {
  const root = temporary(t);
  const workspace = copyFixture(root, 'ready', 'invalid workspace');
  const criterion = path.join(workspace, 'shared', 'acceptance-criteria.md');
  replace(criterion, 'D-001', 'D-999');
  const before = fs.readFileSync(criterion);
  assert.throws(() => validateWorkspace(workspace), /calculated broken_references/u);
  assert.deepEqual(fs.readFileSync(criterion), before);
});

test('INIT, READINESS, and CLOSE transitions preserve their boundaries', (t) => {
  const root = temporary(t);
  const ready = copyFixture(root, 'ready', 'candidate with spaces');
  const absent = path.join(root, 'absent destination');
  assert.equal(validateInitTransition(absent, ready).status, 'ready');
  const readinessCopy = copyFixture(root, 'ready', 'readiness copy');
  assert.equal(validateReadinessTransition(ready, readinessCopy, 'GLOBAL')[1].status, 'ready');
  const closed = copyFixture(root, 'closed', 'closed copy');
  assert.equal(validateCloseTransition(ready, closed)[1].closed, true);
  replace(path.join(readinessCopy, 'feature_spec.md'), 'Provide deterministic', 'Provide changed');
  assert.throws(() => validateReadinessTransition(ready, readinessCopy, 'LOCAL'), /mutated the workspace/u);
});

test('RESUME manifest binds the pre-state and exact feature authority', (t) => {
  const root = temporary(t);
  const before = copyFixture(root, 'ready', 'resume source');
  const after = copyFixture(root, 'ready', 'resume candidate');
  replace(
    path.join(after, 'feature_spec.md'),
    'Provide deterministic invitation expiration behavior.',
    'Provide deterministic invitation expiration behavior with explicit audit semantics.',
  );
  const manifest = path.join(root, 'resume manifest.json');
  fs.writeFileSync(manifest, `${JSON.stringify({
    schema_version: 1,
    mode: 'RESUME',
    workspace_identity: {
      h1: '# Fixture Feature - Feature SPEC',
      pre_state_sha256: resumeWorkspaceIdentity(before),
    },
    allowed_feature_sections: ['Objective'],
    allowed_existing_ids: [],
    allowed_new_ids: [],
    allowed_status_transitions: [],
    allowed_record_status_transitions: [],
  })}\n`, 'utf8');
  assert.equal(validateResumeTransition(before, after, manifest)[1].status, 'ready');
  const denied = path.join(root, 'denied manifest.json');
  const deniedPayload = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  deniedPayload.allowed_feature_sections = [];
  fs.writeFileSync(denied, `${JSON.stringify(deniedPayload)}\n`);
  assert.throws(() => validateResumeTransition(before, after, denied), /allowed_feature_sections/u);
});

const OPTIONAL_HARDLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN', 'EXDEV']);

test('resume identity and snapshots are deterministic', (t) => {
  const root = temporary(t);
  const workspace = copyFixture(root, 'ready', 'identity workspace');
  assert.equal(resumeWorkspaceIdentity(workspace), resumeWorkspaceIdentity(workspace));
  const first = workspaceSnapshot(workspace);
  fs.mkdirSync(path.join(workspace, 'execution'));
  const external = path.join(workspace, 'execution', 'one.bin');
  fs.writeFileSync(external, Buffer.from([0, 1, 2, 255]));
  const second = workspaceSnapshot(workspace);
  assert.notDeepEqual(second, first);
});

test('workspace snapshots include hardlink topology when hardlinks are available', (t) => {
  const root = temporary(t);
  const workspace = copyFixture(root, 'ready', 'hardlink identity workspace');
  fs.mkdirSync(path.join(workspace, 'execution'));
  const external = path.join(workspace, 'execution', 'one.bin');
  fs.writeFileSync(external, Buffer.from([0, 1, 2, 255]));
  try {
    fs.linkSync(external, path.join(workspace, 'execution', 'two.bin'));
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return;
    }
    throw error;
  }
  const second = workspaceSnapshot(workspace);
  const linked = second.filter((entry) => entry[1].startsWith('execution/'));
  assert.equal(linked.length, 2);
  assert.deepEqual(linked[0][4], ['execution/one.bin', 'execution/two.bin']);
});

test('validator CLI preserves success, domain-error, and syntax exit codes from external cwd', (t) => {
  const cwd = temporary(t, 'stnl external cwd ');
  const entry = path.join(RUNTIME_ROOT, 'validate-spec-lifecycle.mjs');
  const fixture = path.join(RUNTIME_ROOT, '..', 'examples', 'validator-fixtures', 'ready');
  const success = spawnSync(process.execPath, [entry, 'workspace', fixture], { cwd, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /^PASS: .* status=ready ids=6$/mu);
  const invalid = spawnSync(process.execPath, [entry, 'workspace', path.join(cwd, 'missing')], { cwd, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^FAIL: /u);
  const syntax = spawnSync(process.execPath, [entry, 'PLANNING'], { cwd, encoding: 'utf8' });
  assert.equal(syntax.status, 2);
  assert.match(syntax.stderr, /invalid choice/u);
});

test('validator CLI accepts equals syntax, repeated options, delimiter, and help like argparse', (t) => {
  const cwd = temporary(t, 'stnl cli grammar ');
  const entry = path.join(RUNTIME_ROOT, 'validate-spec-lifecycle.mjs');
  const before = copyFixture(cwd, 'ready', 'before');
  const after = copyFixture(cwd, 'ready', 'after');
  const equals = spawnSync(process.execPath, [entry, 'readiness-transition', before, after, '--scope=GLOBAL'], { cwd, encoding: 'utf8' });
  assert.equal(equals.status, 0, equals.stderr);
  const repeated = spawnSync(process.execPath, [entry, 'readiness-transition', before, after, '--scope', 'GLOBAL', '--scope', 'LOCAL'], { cwd, encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /READINESS LOCAL/u);
  copyFixture(cwd, 'ready', '-workspace');
  const delimiter = spawnSync(process.execPath, [entry, 'workspace', '--', '-workspace'], { cwd, encoding: 'utf8' });
  assert.equal(delimiter.status, 0, delimiter.stderr);
  for (const flag of ['-h', '--help']) {
    const help = spawnSync(process.execPath, [entry, flag], { cwd, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage:/u);
  }
});
