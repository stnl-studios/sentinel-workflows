import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createReadinessAttestation,
  validateReadinessAttestation,
  workspaceAuthoritySnapshotSha256,
} from '../lib/readiness.mjs';
import { validateWorkspace } from '../lib/lifecycle.mjs';
import { copyFixture, replace, RUNTIME_ROOT, temporary } from './helpers.mjs';

function create(root, source, name = 'readiness.json') {
  return createReadinessAttestation(source, path.join(root, name), { scope: 'GLOBAL', verdict: 'READY' });
}

const OPTIONAL_HARDLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN', 'EXDEV']);

test('attestation payload is minimal, deterministic, UTF-8, and snapshot-bound', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'café 東京 source');
  replace(path.join(source, 'feature_spec.md'), '# Fixture Feature - Feature SPEC', '# Café 東京 - Feature SPEC');
  const first = create(root, source, 'first.json');
  const second = create(root, source, 'second.json');
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
  const payload = JSON.parse(fs.readFileSync(first, 'utf8'));
  assert.deepEqual(Object.keys(payload), ['mode', 'scope', 'verdict', 'version', 'workspace_identity', 'workspace_snapshot_sha256']);
  assert.deepEqual(Object.keys(payload.workspace_identity), ['h1', 'path_sha256']);
  assert.equal(payload.workspace_identity.h1, '# Café 東京 - Feature SPEC');
  assert.equal(payload.workspace_snapshot_sha256, workspaceAuthoritySnapshotSha256(validateWorkspace(source)));
  assert.equal(validateReadinessAttestation(source, first)[1], payload.workspace_snapshot_sha256);
});

test('attestation rejects wrong decision, tampering, duplicate keys, and stale authority without output mutation', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source');
  assert.throws(() => createReadinessAttestation(source, path.join(root, 'local.json'), { scope: 'LOCAL', verdict: 'READY' }), /scope GLOBAL/u);
  assert.throws(() => createReadinessAttestation(source, path.join(root, 'blocked.json'), { scope: 'GLOBAL', verdict: 'BLOCKED' }), /verdict READY/u);
  const valid = create(root, source, 'valid.json');
  const bytes = fs.readFileSync(valid);
  const duplicate = path.join(root, 'duplicate.json');
  fs.writeFileSync(duplicate, fs.readFileSync(valid, 'utf8').replace('"mode":"READINESS"', '"mode":"READINESS","mode":"READINESS"'));
  assert.throws(() => validateReadinessAttestation(source, duplicate), /duplicate JSON field/u);
  replace(path.join(source, 'feature_spec.md'), 'Provide deterministic', 'Provide durably deterministic');
  validateWorkspace(source);
  assert.throws(() => validateReadinessAttestation(source, valid), /stale/u);
  assert.deepEqual(fs.readFileSync(valid), bytes);
});

test('attestation parser enforces exact schema, types, constants, UTF-8, and size limit', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source');
  const valid = create(root, source, 'valid.json');
  const base = JSON.parse(fs.readFileSync(valid, 'utf8'));
  const cases = [
    ['unknown', { ...base, unexpected: true }, /unknown=\['unexpected'\]/u],
    ['version', { ...base, version: 2 }, /unsupported version/u],
    ['mode', { ...base, mode: 'CLOSE' }, /mode READINESS/u],
    ['scope', { ...base, scope: 'LOCAL' }, /scope GLOBAL/u],
    ['verdict', { ...base, verdict: 'BLOCKED' }, /verdict READY/u],
    ['digest', { ...base, workspace_snapshot_sha256: 'INVALID' }, /lowercase SHA-256/u],
  ];
  for (const [name, value, diagnostic] of cases) {
    const file = path.join(root, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    assert.throws(() => validateReadinessAttestation(source, file), diagnostic);
  }
  const reordered = path.join(root, 'reordered-identity.json');
  fs.writeFileSync(reordered, `${JSON.stringify({ ...base, workspace_identity: { path_sha256: base.workspace_identity.path_sha256, h1: base.workspace_identity.h1 } })}\n`);
  assert.doesNotThrow(() => validateReadinessAttestation(source, reordered));
  const invalidConstant = path.join(root, 'constant.json');
  fs.writeFileSync(invalidConstant, fs.readFileSync(valid, 'utf8').replace('"version":1', '"version":NaN'));
  assert.throws(() => validateReadinessAttestation(source, invalidConstant), /invalid JSON constant 'NaN'/u);
  const malformedUtf8 = path.join(root, 'malformed-utf8.json');
  fs.writeFileSync(malformedUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.throws(() => validateReadinessAttestation(source, malformedUtf8), /malformed/u);
  const oversized = path.join(root, 'oversized.json');
  fs.writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x20));
  assert.throws(() => validateReadinessAttestation(source, oversized), /safe size limit/u);
});

test('external data is excluded and unsafe attestation paths are rejected', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'source');
  const before = workspaceAuthoritySnapshotSha256(validateWorkspace(source));
  fs.mkdirSync(path.join(source, 'execution'));
  fs.writeFileSync(path.join(source, 'execution', 'evidence.bin'), Buffer.from([0, 255]));
  assert.equal(workspaceAuthoritySnapshotSha256(validateWorkspace(source)), before);
  assert.throws(() => createReadinessAttestation(source, path.join(source, 'internal.json'), { scope: 'GLOBAL', verdict: 'READY' }), /outside the workspace/u);
});

test('lifecycle hardlinks are rejected when hardlinks are available', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'hardlink source');
  const authority = path.join(source, 'shared', 'requirements.md');
  try {
    fs.linkSync(authority, path.join(root, 'authority link.md'));
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return;
    }
    throw error;
  }
  assert.throws(() => create(root, source, 'linked-authority.json'), /single-link regular file/u);
});

test('attestation CLI works from unrelated cwd with paths containing spaces and uses exit 2 for missing flags', (t) => {
  const root = temporary(t, 'stnl readiness cli ');
  const source = copyFixture(root, 'ready', 'source with spaces');
  const cwd = path.join(root, 'external cwd');
  fs.mkdirSync(cwd);
  const entry = path.join(RUNTIME_ROOT, 'create-readiness-attestation.mjs');
  const output = path.join(root, 'receipt with spaces.json');
  const success = spawnSync(process.execPath, [entry, source, output, '--scope', 'GLOBAL', '--verdict', 'READY'], { cwd, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /^PASS: readiness attestation created at /u);
  const missing = spawnSync(process.execPath, [entry, source, path.join(root, 'missing.json'), '--scope', 'GLOBAL'], { cwd, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--verdict/u);
});

test('attestation CLI accepts equals and last repeated value, and help exits successfully', (t) => {
  const root = temporary(t, 'stnl readiness grammar ');
  const source = copyFixture(root, 'ready', 'source');
  const entry = path.join(RUNTIME_ROOT, 'create-readiness-attestation.mjs');
  const output = path.join(root, 'equals.json');
  const equals = spawnSync(process.execPath, [entry, source, output, '--scope=LOCAL', '--scope=GLOBAL', '--verdict=READY'], { cwd: root, encoding: 'utf8' });
  assert.equal(equals.status, 0, equals.stderr);
  const help = spawnSync(process.execPath, [entry, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage:/u);
});
