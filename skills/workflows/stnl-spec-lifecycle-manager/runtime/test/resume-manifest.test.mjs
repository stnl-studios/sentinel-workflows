import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  resumeWorkspaceIdentity,
  validateResumeTransition,
} from '../lib/lifecycle.mjs';
import { isWithin } from '../lib/core.mjs';
import { copyFixture, RUNTIME_ROOT, temporary } from './helpers.mjs';

const ENTRY = path.join(RUNTIME_ROOT, 'create-resume-manifest.mjs');

test('RESUME manifest template provides the exact source identity and stale manifests remain rejected', (t) => {
  const root = temporary(t, 'stnl resume manifest template ');
  const source = copyFixture(root, 'ready', 'source workspace');
  const candidate = copyFixture(root, 'ready', 'candidate workspace');
  const result = spawnSync(process.execPath, [ENTRY, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^PASS: RESUME manifest template created at (.+)$/mu);
  assert.ok(match, result.stdout);
  const manifestPath = match[1];
  t.after(() => fs.rmSync(manifestPath, { force: true }));
  assert.equal(isWithin(manifestPath, source), false);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.workspace_identity.h1, '# Fixture Feature - Feature SPEC');
  assert.equal(manifest.workspace_identity.pre_state_sha256, resumeWorkspaceIdentity(source));
  assert.deepEqual(manifest.allowed_feature_sections, []);
  assert.deepEqual(manifest.allowed_existing_ids, []);
  assert.deepEqual(manifest.allowed_new_ids, []);
  assert.deepEqual(manifest.allowed_status_transitions, []);
  assert.deepEqual(manifest.allowed_record_status_transitions, []);

  manifest.allowed_feature_sections = ['Objective'];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  const feature = path.join(candidate, 'feature_spec.md');
  const candidateText = fs.readFileSync(feature, 'utf8');
  fs.writeFileSync(feature, candidateText.replace(
    'Provide deterministic invitation expiration behavior.',
    'Provide deterministic invitation expiration behavior with an explicit boundary.',
  ), 'utf8');
  assert.equal(validateResumeTransition(source, candidate, manifestPath)[1].status, 'ready');

  const sourceFeature = path.join(source, 'feature_spec.md');
  const sourceText = fs.readFileSync(sourceFeature, 'utf8');
  fs.writeFileSync(sourceFeature, sourceText.replace(
    'Provide deterministic invitation expiration behavior.',
    'Provide changed source content after manifest creation.',
  ), 'utf8');
  assert.throws(
    () => validateResumeTransition(source, candidate, manifestPath),
    /pre-state identity does not match the source workspace/u,
  );
});

test('RESUME manifest template accepts a direct feature_spec.md path', (t) => {
  const root = temporary(t, 'stnl resume manifest feature path ');
  const source = copyFixture(root, 'ready', 'workspace');
  const result = spawnSync(process.execPath, [ENTRY, path.join(source, 'feature_spec.md')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^PASS: RESUME manifest template created at (.+)$/mu);
  assert.ok(match, result.stdout);
  t.after(() => fs.rmSync(match[1], { force: true }));
  const manifest = JSON.parse(fs.readFileSync(match[1], 'utf8'));
  assert.equal(manifest.workspace_identity.pre_state_sha256, resumeWorkspaceIdentity(source));
});

test('RESUME manifest template refuses closed SPECs', (t) => {
  const root = temporary(t, 'stnl resume manifest closed ');
  const source = copyFixture(root, 'closed', 'closed workspace');
  const result = spawnSync(process.execPath, [ENTRY, source], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^FAIL: RESUME requires an active SPEC$/mu);
  assert.equal(result.stdout, '');
});
