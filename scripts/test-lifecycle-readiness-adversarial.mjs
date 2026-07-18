#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MAX_ATTESTATION_BYTES,
  createReadinessAttestation,
  validateReadinessAttestation,
  workspaceAuthoritySnapshotSha256,
} from '../skills/stnl-spec-lifecycle-manager/runtime/lib/readiness.mjs';
import { buildClosedCandidate } from '../skills/stnl-spec-lifecycle-manager/runtime/lib/closed-spec.mjs';
import {
  ValidationError,
  validateWorkspace,
  workspaceSnapshot,
} from '../skills/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = path.join(REPOSITORY_ROOT, 'skills', 'stnl-spec-lifecycle-manager');
const FIXTURES = path.join(SKILL_ROOT, 'examples', 'validator-fixtures');
const RENDERER = path.join(SKILL_ROOT, 'runtime', 'build-closed-spec.mjs');
const OPTIONAL_SYMLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, 'EXDEV']);

function temporary(t, prefix = 'stnl readiness adversarial ') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fresh(root, name = 'source') {
  const source = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, 'ready'), source, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  return source;
}

function attestation(root, source, name = 'readiness.json') {
  return createReadinessAttestation(source, path.join(root, name), {
    scope: 'GLOBAL',
    verdict: 'READY',
  });
}

function build(root, source, receipt, name = 'candidate') {
  return buildClosedCandidate(source, path.join(root, name), { readinessAttestation: receipt });
}

function replace(file, before, after) {
  const current = fs.readFileSync(file, 'utf8');
  assert(current.includes(before), `fixture text not found: ${before}`);
  fs.writeFileSync(file, current.replace(before, after), 'utf8');
}

function writePayload(root, name, payload) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  return file;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function createSymlinkOrSkip(t, target, link, type = undefined) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error?.code)) {
      t.skip(`symlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

function createHardlinkOrSkip(t, source, destination) {
  try {
    fs.linkSync(source, destination);
    return true;
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error?.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

function stageResidues(root, candidateName) {
  return fs.readdirSync(root).filter((name) => name.startsWith(`.${candidateName}.close-stage-`));
}

test('deep readiness schema mutations are rejected before candidate creation', async (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const valid = attestation(root, source, 'valid.json');
  const base = JSON.parse(fs.readFileSync(valid, 'utf8'));
  const cases = [
    ['identity unknown field', (value) => { value.workspace_identity.unexpected = 'value'; }, /workspace_identity fields.*unknown=\['unexpected'\]/u],
    ['missing verdict', (value) => { delete value.verdict; }, /missing=\['verdict'\]/u],
    ['boolean version', (value) => { value.version = true; }, /unsupported version/u],
    ['identity array', (value) => { value.workspace_identity = []; }, /workspace_identity must be a JSON object/u],
    ['missing identity h1', (value) => { delete value.workspace_identity.h1; }, /missing=\['h1'\]/u],
    ['uppercase snapshot digest', (value) => { value.workspace_snapshot_sha256 = value.workspace_snapshot_sha256.toUpperCase(); }, /lowercase SHA-256/u],
    ['empty identity h1', (value) => { value.workspace_identity.h1 = ''; }, /must be a non-empty string/u],
    ['wrong path digest type', (value) => { value.workspace_identity.path_sha256 = 7; }, /must be a non-empty string/u],
  ];
  for (const [index, [name, mutate, diagnostic]] of cases.entries()) {
    await t.test(name, () => {
      const payload = structuredClone(base);
      mutate(payload);
      const receipt = writePayload(root, `schema-${index}.json`, payload);
      const candidateName = `schema-candidate-${index}`;
      assert.throws(
        () => build(root, source, receipt, candidateName),
        (error) => error instanceof ValidationError && diagnostic.test(error.message),
      );
      assert.equal(exists(path.join(root, candidateName)), false);
      assert.deepEqual(stageResidues(root, candidateName), []);
    });
  }

  await t.test('nested duplicate identity field', () => {
    const duplicate = path.join(root, 'nested-duplicate.json');
    const raw = fs.readFileSync(valid, 'utf8').replace(
      '"h1":"# Fixture Feature - Feature SPEC"',
      '"h1":"# Fixture Feature - Feature SPEC","h1":"# Fixture Feature - Feature SPEC"',
    );
    fs.writeFileSync(duplicate, raw, 'utf8');
    assert.throws(() => build(root, source, duplicate, 'nested-duplicate-candidate'), /duplicate JSON field 'h1'/u);
    assert.equal(exists(path.join(root, 'nested-duplicate-candidate')), false);
  });

  await t.test('root array', () => {
    const receipt = path.join(root, 'root-array.json');
    fs.writeFileSync(receipt, '[]\n', 'utf8');
    assert.throws(() => build(root, source, receipt, 'root-array-candidate'), /root must be a JSON object/u);
    assert.equal(exists(path.join(root, 'root-array-candidate')), false);
  });

  await t.test('UTF-8 BOM', () => {
    const receipt = path.join(root, 'bom.json');
    fs.writeFileSync(receipt, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(valid)]));
    assert.throws(() => build(root, source, receipt, 'bom-candidate'), /malformed/u);
    assert.equal(exists(path.join(root, 'bom-candidate')), false);
  });
});

test('invalid workspace and invalid decisions create no attestation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  replace(path.join(source, 'shared', 'acceptance-criteria.md'), 'D-001', 'D-999');
  const invalidOutput = path.join(root, 'invalid-workspace.json');
  assert.throws(
    () => createReadinessAttestation(source, invalidOutput, { scope: 'GLOBAL', verdict: 'READY' }),
    /broken_references/u,
  );
  assert.equal(exists(invalidOutput), false);

  const safe = fresh(root, 'safe source');
  for (const [scope, verdict, diagnostic] of [
    ['LOCAL', 'READY', /scope GLOBAL/u],
    ['GLOBAL', 'BLOCKED', /verdict READY/u],
    ['GLOBAL', 'UNKNOWN', /verdict READY/u],
  ]) {
    const output = path.join(root, `rejected-${scope}-${verdict}.json`);
    assert.throws(() => createReadinessAttestation(safe, output, { scope, verdict }), diagnostic);
    assert.equal(exists(output), false);
  }
});

test('traversal and workspace-internal attestation paths are rejected without mutation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const sourceBefore = workspaceSnapshot(source);
  const traversalOutput = `${root}${path.sep}unused${path.sep}..${path.sep}traversal.json`;
  assert.throws(
    () => createReadinessAttestation(source, traversalOutput, { scope: 'GLOBAL', verdict: 'READY' }),
    /path traversal/u,
  );
  assert.equal(exists(path.join(root, 'traversal.json')), false);
  const internal = path.join(source, 'internal.json');
  assert.throws(
    () => createReadinessAttestation(source, internal, { scope: 'GLOBAL', verdict: 'READY' }),
    /outside the workspace/u,
  );
  assert.equal(exists(internal), false);

  const valid = attestation(root, source, 'valid.json');
  const traversalInput = `${root}${path.sep}unused${path.sep}..${path.sep}${path.basename(valid)}`;
  assert.throws(() => build(root, source, traversalInput, 'traversal-candidate'), /path traversal/u);
  assert.equal(exists(path.join(root, 'traversal-candidate')), false);
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
});

test('attestation output symlink is rejected without touching its target', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const target = path.join(root, 'external-target.json');
  fs.writeFileSync(target, 'external', 'utf8');
  const linked = path.join(root, 'attestation-symlink.json');
  if (!createSymlinkOrSkip(t, target, linked, process.platform === 'win32' ? 'file' : undefined)) return;
  assert.throws(
    () => createReadinessAttestation(source, linked, { scope: 'GLOBAL', verdict: 'READY' }),
    /symlink components/u,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'external');
});

test('attestation output symlink parent is rejected without external creation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const realParent = path.join(root, 'real-parent');
  fs.mkdirSync(realParent);
  const linkedParent = path.join(root, 'linked-parent');
  if (!createSymlinkOrSkip(t, realParent, linkedParent, process.platform === 'win32' ? 'junction' : undefined)) return;
  assert.throws(
    () => createReadinessAttestation(source, path.join(linkedParent, 'receipt.json'), { scope: 'GLOBAL', verdict: 'READY' }),
    /symlink components/u,
  );
  assert.deepEqual(fs.readdirSync(realParent), []);
});

test('attestation input symlink and nested symlink ancestors are rejected without external mutation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const valid = attestation(root, source, 'valid.json');
  const external = path.join(root, 'external-target');
  const nested = path.join(external, 'one', 'two');
  fs.mkdirSync(nested, { recursive: true });
  const sentinel = path.join(external, 'sentinel.bin');
  fs.writeFileSync(sentinel, Buffer.from('external target must remain unchanged\0'));
  const externalReceipt = path.join(nested, 'existing.json');
  fs.copyFileSync(valid, externalReceipt);
  const beforeSentinel = fs.readFileSync(sentinel);
  const beforeReceipt = fs.readFileSync(externalReceipt);
  const alias = path.join(root, 'attestation-alias');
  if (!createSymlinkOrSkip(t, external, alias, process.platform === 'win32' ? 'junction' : undefined)) return;
  const aliasedReceipt = path.join(alias, 'one', 'two', 'existing.json');
  assert.throws(() => validateReadinessAttestation(source, aliasedReceipt), /symlink components/u);
  assert.throws(() => build(root, source, aliasedReceipt, 'nested-alias-candidate'), /symlink components/u);
  assert.throws(
    () => createReadinessAttestation(source, path.join(alias, 'one', 'two', 'created.json'), { scope: 'GLOBAL', verdict: 'READY' }),
    /symlink components/u,
  );
  assert.equal(exists(path.join(nested, 'created.json')), false);
  assert.equal(exists(path.join(root, 'nested-alias-candidate')), false);
  assert.deepEqual(stageResidues(root, 'nested-alias-candidate'), []);
  assert.deepEqual(fs.readFileSync(sentinel), beforeSentinel);
  assert.deepEqual(fs.readFileSync(externalReceipt), beforeReceipt);
});

test('direct attestation input symlink is rejected without candidate creation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const valid = attestation(root, source, 'valid.json');
  const linked = path.join(root, 'linked.json');
  if (!createSymlinkOrSkip(t, valid, linked, process.platform === 'win32' ? 'file' : undefined)) return;
  const before = fs.readFileSync(valid);
  assert.throws(() => build(root, source, linked, 'linked-candidate'), /symlink components/u);
  assert.equal(exists(path.join(root, 'linked-candidate')), false);
  assert.deepEqual(fs.readFileSync(valid), before);
});

test('workspace-internal attestation input is rejected without source mutation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const valid = attestation(root, source, 'valid.json');
  const internal = path.join(source, 'manual-attestation.json');
  fs.copyFileSync(valid, internal);
  const sourceBefore = workspaceSnapshot(source);
  const internalBefore = fs.readFileSync(internal);
  assert.throws(() => build(root, source, internal, 'internal-candidate'), /outside the workspace/u);
  assert.equal(exists(path.join(root, 'internal-candidate')), false);
  assert.deepEqual(stageResidues(root, 'internal-candidate'), []);
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
  assert.deepEqual(fs.readFileSync(internal), internalBefore);
});

test('hardlinked attestation is rejected without candidate creation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const valid = attestation(root, source, 'valid.json');
  const linked = path.join(root, 'hardlinked.json');
  if (!createHardlinkOrSkip(t, valid, linked)) return;
  const bytes = fs.readFileSync(valid);
  assert.throws(() => build(root, source, linked, 'hardlinked-candidate'), /single-link regular file/u);
  assert.equal(exists(path.join(root, 'hardlinked-candidate')), false);
  assert.deepEqual(fs.readFileSync(valid), bytes);
  assert.deepEqual(fs.readFileSync(linked), bytes);
});

test('hardlinked lifecycle authority blocks attestation before output creation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const authority = path.join(source, 'shared', 'requirements.md');
  const linked = path.join(root, 'authority-link.md');
  if (!createHardlinkOrSkip(t, authority, linked)) return;
  const before = fs.readFileSync(linked);
  const output = path.join(root, 'authority-hardlink-receipt.json');
  assert.throws(
    () => createReadinessAttestation(source, output, { scope: 'GLOBAL', verdict: 'READY' }),
    /authority must be a single-link/u,
  );
  assert.equal(exists(output), false);
  assert.deepEqual(fs.readFileSync(linked), before);
});

test('directory attestation input fails fast through the CLI without candidate creation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const directory = path.join(root, 'attestation-directory');
  fs.mkdirSync(directory);
  const candidate = path.join(root, 'directory-candidate');
  const result = spawnSync(
    process.execPath,
    [RENDERER, source, candidate, '--readiness-attestation', directory],
    { cwd: root, encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /single-link regular file/u);
  assert.equal(exists(candidate), false);
});

test('Unix-domain socket attestation input fails fast through the CLI without candidate creation', async (t) => {
  if (process.platform === 'win32') {
    t.skip('filesystem Unix-domain sockets are unavailable on Windows');
    return;
  }
  const root = temporary(t, 'stnl rd sock ');
  const source = fresh(root);
  const socket = path.join(root, 'receipt.sock');
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error?.code)) {
      t.skip(`filesystem Unix-domain sockets unavailable (${error.code})`);
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const candidate = path.join(root, 'socket-candidate');
  const result = spawnSync(
    process.execPath,
    [RENDERER, source, candidate, '--readiness-attestation', socket],
    { cwd: root, encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /single-link regular file/u);
  assert.equal(exists(candidate), false);
});

test('every valid authority mutation stales the attestation without changing the receipt', async (t) => {
  const mutations = [
    ['objective', (source) => replace(path.join(source, 'feature_spec.md'), 'Provide deterministic invitation expiration behavior.', 'Changed after READINESS GLOBAL.')],
    ['whitespace', (source) => fs.appendFileSync(path.join(source, 'feature_spec.md'), '\n')],
    ['requirement', (source) => replace(path.join(source, 'shared', 'requirements.md'), 'An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.', 'Changed requirement authority after readiness.')],
    ['acceptance criterion', (source) => replace(path.join(source, 'shared', 'acceptance-criteria.md'), 'a API rejeita a aceitação com o envelope público de convite expirado', 'a API retorna um resultado revisado depois da readiness global')],
    ['status', (source) => replace(path.join(source, 'shared', 'risks.md'), '- status: active\n- impact: medium', '- status: retired\n- retired_reason: Monitoring eliminated this exposure.\n- impact: medium')],
    ['added record', (source) => {
      replace(path.join(source, 'feature_spec.md'), '- R-001\n', '- R-001\n- R-002\n');
      fs.appendFileSync(path.join(source, 'shared', 'requirements.md'), `
### R-002 — Retired duplicate requirement

- status: retired
- retired_reason: The requirement duplicated R-001 and remains reserved for history.

This authority remains as a documentary tombstone.
`, 'utf8');
    }],
    ['removed record category', (source) => {
      replace(path.join(source, 'feature_spec.md'), '  risks: shared/risks.md\n', '');
      fs.unlinkSync(path.join(source, 'shared', 'risks.md'));
      replace(path.join(source, 'shared', 'acceptance-criteria.md'), '- references: [D-001, C-001, RK-001]', '- references: [D-001, C-001]');
    }],
  ];

  for (const [index, [name, mutate]] of mutations.entries()) {
    await t.test(name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `stnl stale ${index} `));
      try {
        const source = fresh(root);
        const receipt = attestation(root, source);
        const receiptBefore = fs.readFileSync(receipt);
        mutate(source);
        assert.doesNotThrow(() => validateWorkspace(source));
        const candidate = path.join(root, 'candidate');
        assert.throws(
          () => buildClosedCandidate(source, candidate, { readinessAttestation: receipt }),
          /stale/u,
        );
        assert.equal(exists(candidate), false);
        assert.deepEqual(stageResidues(root, 'candidate'), []);
        assert.deepEqual(fs.readFileSync(receipt), receiptBefore);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('a fresh attestation after a valid authority change closes successfully', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const stale = attestation(root, source, 'stale.json');
  const staleBefore = fs.readFileSync(stale);
  mutateObjectiveForFreshReceipt(source);
  assert.throws(() => build(root, source, stale, 'stale-candidate'), /stale/u);
  assert.equal(exists(path.join(root, 'stale-candidate')), false);
  assert.deepEqual(fs.readFileSync(stale), staleBefore);
  const freshReceipt = attestation(root, source, 'fresh.json');
  const candidate = build(root, source, freshReceipt, 'fresh-candidate');
  assert.match(fs.readFileSync(path.join(candidate, 'feature_spec.md'), 'utf8'), /Reviewed replacement objective/u);
});

function mutateObjectiveForFreshReceipt(source) {
  replace(
    path.join(source, 'feature_spec.md'),
    'Provide deterministic invitation expiration behavior.',
    'Reviewed replacement objective.',
  );
  validateWorkspace(source);
}

test('external execution data and persistent sibling metadata do not change readiness authority', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const before = workspaceAuthoritySnapshotSha256(validateWorkspace(source));
  fs.mkdirSync(path.join(source, 'execution'));
  fs.writeFileSync(path.join(source, 'execution', 'evidence.bin'), Buffer.from([0, 255, 1]));
  fs.writeFileSync(path.join(source, '.DS_Store'), 'ignored', 'utf8');
  fs.writeFileSync(path.join(root, `.${path.basename(source)}.lifecycle.lock`), 'runtime metadata', 'utf8');
  fs.writeFileSync(path.join(root, `.${path.basename(source)}.lifecycle-transaction.json`), 'runtime metadata', 'utf8');
  const [workspace, after] = validateReadinessAttestation(source, receipt);
  assert.equal(after, before);
  assert.equal(after, workspaceAuthoritySnapshotSha256(workspace));
  const candidate = build(root, source, receipt);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'execution', 'evidence.bin')), Buffer.from([0, 255, 1]));
  assert.equal(exists(path.join(candidate, '.DS_Store')), false);
  assert.equal(fs.readFileSync(path.join(candidate, 'feature_spec.md'), 'utf8').includes('workspace_snapshot_sha256'), false);
});

test('candidate-boundary and mismatched-workspace attestations are rejected without candidates', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  assert.throws(
    () => validateReadinessAttestation(source, receipt, { candidate: root }),
    /outside the candidate/u,
  );

  const other = fresh(root, 'other source');
  assert.throws(() => build(root, other, receipt, 'other-candidate'), /workspace identity/u);
  assert.equal(exists(path.join(root, 'other-candidate')), false);

  const forged = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  forged.workspace_identity.path_sha256 = '0'.repeat(64);
  const forgedReceipt = writePayload(root, 'forged-path.json', forged);
  assert.throws(() => build(root, source, forgedReceipt, 'forged-candidate'), /workspace identity/u);
  assert.equal(exists(path.join(root, 'forged-candidate')), false);
});

test('case-variant physical aliases cannot hide an internal attestation', (t) => {
  const root = temporary(t);
  const realParent = path.join(root, 'ParentCase');
  fs.mkdirSync(realParent);
  const source = fresh(realParent, 'Source');
  const aliasParent = path.join(root, 'parentcase');
  const aliasSource = path.join(aliasParent, 'source');
  let aliasMetadata;
  try {
    aliasMetadata = fs.statSync(aliasSource);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      t.skip('case-variant aliases are unavailable on this case-sensitive filesystem');
      return;
    }
    throw error;
  }
  const sourceMetadata = fs.statSync(source);
  if (String(aliasMetadata.dev) !== String(sourceMetadata.dev) || String(aliasMetadata.ino) !== String(sourceMetadata.ino)) {
    t.skip('case-variant aliases are unavailable on this filesystem');
    return;
  }

  const requestedOutput = path.join(aliasSource, 'readiness.json');
  assert.throws(
    () => createReadinessAttestation(source, requestedOutput, { scope: 'GLOBAL', verdict: 'READY' }),
    /outside the workspace/u,
  );
  assert.equal(exists(path.join(source, 'readiness.json')), false);

  const valid = attestation(root, source, 'case-valid.json');
  const internal = path.join(source, 'manual.json');
  fs.copyFileSync(valid, internal);
  const sourceBefore = workspaceSnapshot(source);
  const internalBefore = fs.readFileSync(internal);
  assert.throws(() => build(root, source, path.join(aliasSource, 'manual.json'), 'case-candidate'), /outside the workspace/u);
  assert.equal(exists(path.join(root, 'case-candidate')), false);
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
  assert.deepEqual(fs.readFileSync(internal), internalBefore);
});

test('an output-creation race preserves the competitor file and workspace', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const sourceBefore = workspaceSnapshot(source);
  const output = path.join(root, 'raced-output.json');
  const canonicalOutput = path.join(fs.realpathSync(root), path.basename(output));
  const competitor = Buffer.from('competitor-owned\0bytes');
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = function patchedOpen(file, flags, ...rest) {
    if (!injected && path.normalize(String(file)) === canonicalOutput && (flags & fs.constants.O_EXCL) !== 0) {
      injected = true;
      const descriptor = originalOpen.call(fs, file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(descriptor, competitor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    return originalOpen.call(fs, file, flags, ...rest);
  };
  try {
    assert.throws(
      () => createReadinessAttestation(source, output, { scope: 'GLOBAL', verdict: 'READY' }),
      (error) => error?.code === 'EEXIST',
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(output), competitor);
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
});

test('authority mutation during validation fails before creating an attestation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const requirements = path.join(source, 'shared', 'requirements.md');
  const canonicalRequirements = fs.realpathSync(requirements);
  const output = path.join(root, 'raced-authority.json');
  const originalRead = fs.readFileSync;
  let mutated = false;
  fs.readFileSync = function mutateAfterValidationRead(file, ...rest) {
    const data = originalRead.call(fs, file, ...rest);
    if (!mutated && typeof file !== 'number' && path.normalize(String(file)) === canonicalRequirements) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const changed = text.replace(
        'An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.',
        'An invitation past `expires_at` is rejected under the concurrently revised UTC authority.',
      );
      assert.notEqual(changed, text);
      fs.writeFileSync(canonicalRequirements, changed, 'utf8');
      mutated = true;
    }
    return data;
  };
  try {
    assert.throws(
      () => createReadinessAttestation(source, output, { scope: 'GLOBAL', verdict: 'READY' }),
      /source authority changed during attestation creation/u,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(mutated, true);
  assert.doesNotThrow(() => validateWorkspace(source));
  assert.equal(exists(output), false);
});

test('source mutation after output fsync removes only the owned attestation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const output = path.join(root, 'post-fsync-source-race.json');
  const originalFsync = fs.fsyncSync;
  let mutated = false;
  fs.fsyncSync = function mutateSourceAfterPersistence(descriptor) {
    const result = originalFsync.call(fs, descriptor);
    if (!mutated) {
      replace(
        path.join(source, 'shared', 'requirements.md'),
        'An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.',
        'An invitation past `expires_at` is rejected under post-persistence UTC authority.',
      );
      mutated = true;
    }
    return result;
  };
  try {
    assert.throws(
      () => createReadinessAttestation(source, output, { scope: 'GLOBAL', verdict: 'READY' }),
      /source authority changed during attestation creation/u,
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(mutated, true);
  assert.doesNotThrow(() => validateWorkspace(source));
  assert.equal(exists(output), false);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.includes('.attestation-cleanup-')),
    [],
  );
});

test('output swaps after exclusive open are detected and foreign replacements are preserved', async (t) => {
  for (const throwsAfterSwap of [false, true]) {
    await t.test(throwsAfterSwap ? 'write path throws after swap' : 'success path revalidates ownership', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stnl receipt swap '));
      try {
        const source = fresh(root);
        const output = path.join(root, 'receipt.json');
        const displaced = path.join(root, 'displaced-owned-receipt.json');
        const foreign = Buffer.from(`FOREIGN SENTINEL ${throwsAfterSwap ? 'error' : 'success'}\0`);
        const originalFsync = fs.fsyncSync;
        let swapped = false;
        fs.fsyncSync = function swapAfterExclusiveOpen(descriptor) {
          const result = originalFsync.call(fs, descriptor);
          if (!swapped) {
            fs.renameSync(output, displaced);
            fs.writeFileSync(output, foreign);
            swapped = true;
            if (throwsAfterSwap) {
              const error = new Error('injected failure after foreign output swap');
              error.code = 'EIO';
              throw error;
            }
          }
          return result;
        };
        try {
          assert.throws(
            () => createReadinessAttestation(source, output, { scope: 'GLOBAL', verdict: 'READY' }),
            throwsAfterSwap ? /injected failure/u : /output ownership changed during creation/u,
          );
        } finally {
          fs.fsyncSync = originalFsync;
        }
        assert.equal(swapped, true);
        assert.deepEqual(fs.readFileSync(output), foreign);
        assert.match(fs.readFileSync(displaced, 'utf8'), /^\{"mode":"READINESS"/u);
        assert.deepEqual(
          fs.readdirSync(root).filter((name) => name.includes('.attestation-cleanup-')),
          [],
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('legacy readiness boolean remains a syntax error even beside a valid receipt', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const candidate = path.join(root, 'legacy-candidate');
  const result = spawnSync(
    process.execPath,
    [RENDERER, source, candidate, '--readiness-attestation', receipt, '--global-readiness-confirmed'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unrecognized arguments: --global-readiness-confirmed/u);
  assert.equal(exists(candidate), false);
});

test('attestation size boundary accepts the canonical receipt and rejects oversized input', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const oversized = path.join(root, 'oversized.json');
  fs.writeFileSync(oversized, Buffer.alloc(MAX_ATTESTATION_BYTES + 1, 0x20));
  assert.throws(() => validateReadinessAttestation(source, oversized), /safe size limit/u);
});
