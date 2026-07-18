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
  buildClosedCandidate,
} from '../skills/stnl-spec-lifecycle-manager/runtime/lib/closed-spec.mjs';
import {
  createReadinessAttestation,
} from '../skills/stnl-spec-lifecycle-manager/runtime/lib/readiness.mjs';
import {
  ValidationError,
  validateCloseTransition,
  validateWorkspace,
  workspaceSnapshot,
} from '../skills/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = path.join(REPOSITORY_ROOT, 'skills', 'stnl-spec-lifecycle-manager');
const FIXTURES = path.join(SKILL_ROOT, 'examples', 'validator-fixtures');
const RENDERER = path.join(SKILL_ROOT, 'runtime', 'build-closed-spec.mjs');
const OPTIONAL_SYMLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, 'EXDEV']);

function temporary(t, prefix = 'stnl renderer adversarial ') {
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

function build(root, source, name = 'candidate', receipt = null) {
  const readinessAttestation = receipt ?? attestation(root, source);
  return buildClosedCandidate(source, path.join(root, name), { readinessAttestation });
}

function replace(file, before, after) {
  const current = fs.readFileSync(file, 'utf8');
  assert(current.includes(before), `fixture text not found: ${before}`);
  fs.writeFileSync(file, current.replace(before, after), 'utf8');
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

function stageResidues(root, candidateName) {
  return fs.readdirSync(root).filter((name) => name.startsWith(`.${candidateName}.close-stage-`));
}

function treeSnapshot(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const relative = path.relative(root, entry).split(path.sep).join('/');
      const metadata = fs.lstatSync(entry);
      if (metadata.isSymbolicLink()) result.push([relative, 'symlink', fs.readlinkSync(entry)]);
      else if (metadata.isDirectory()) {
        result.push([relative, 'directory', '']);
        visit(entry);
      } else if (metadata.isFile()) result.push([relative, 'file', fs.readFileSync(entry).toString('base64')]);
      else result.push([relative, 'special', `${metadata.mode}:${metadata.dev}:${metadata.ino}`]);
    }
  }
  visit(root);
  return result;
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

function mutateObjective(source, text) {
  replace(
    path.join(source, 'feature_spec.md'),
    'Provide deterministic invitation expiration behavior.',
    text,
  );
  validateWorkspace(source);
}

test('optional canonical categories are omitted rather than rendered as empty headings', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const feature = path.join(source, 'feature_spec.md');
  for (const line of [
    '  decisions: shared/decisions.md\n',
    '  constraints: shared/constraints.md\n',
    '  risks: shared/risks.md\n',
    '  questions: shared/questions.md\n',
  ]) replace(feature, line, '');
  for (const name of ['decisions.md', 'constraints.md', 'risks.md', 'questions.md']) {
    fs.unlinkSync(path.join(source, 'shared', name));
  }
  replace(
    path.join(source, 'shared', 'acceptance-criteria.md'),
    '- references: [D-001, C-001, RK-001]\n',
    '',
  );
  validateWorkspace(source);
  const rendered = fs.readFileSync(path.join(build(root, source), 'feature_spec.md'), 'utf8');
  for (const heading of ['Durable Decisions', 'Relevant Constraints', 'Relevant Risks', 'Durable Resolved Questions']) {
    assert.equal(rendered.includes(`## ${heading}\n`), false, heading);
  }
});

test('renderer output is byte-identical across V8 hash seeds and locale environments', (t) => {
  const root = temporary(t);
  const source = fresh(root, 'unicode source');
  mutateObjective(source, 'Preservar expiração determinística — café, ação e 東京.');
  const receipt = attestation(root, source);
  const sourceBefore = workspaceSnapshot(source);
  const candidates = [path.join(root, 'candidate C'), path.join(root, 'candidate pt BR')];
  const variants = [
    { seed: 1, locale: 'C' },
    { seed: 2, locale: 'pt_BR.UTF-8' },
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    const result = spawnSync(
      process.execPath,
      [`--hash-seed=${variants[index].seed}`, RENDERER, source, candidates[index], '--readiness-attestation', receipt],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: variants[index].locale, LANG: variants[index].locale },
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(treeSnapshot(candidates[0]), treeSnapshot(candidates[1]));
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
});

test('external directories and files are preserved while all OS metadata forms are omitted', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'execution');
  fs.mkdirSync(path.join(execution, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(execution, 'payload.bin'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(source, '.DS_Store'), 'ignored');
  fs.writeFileSync(path.join(source, '._finder'), 'ignored');
  fs.mkdirSync(path.join(source, '__MACOSX'));
  fs.writeFileSync(path.join(source, '__MACOSX', 'ignored'), 'ignored');
  const sourceBefore = treeSnapshot(source);
  const candidate = build(root, source);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'execution', 'payload.bin')), Buffer.from([0, 1, 255]));
  assert.equal(fs.statSync(path.join(candidate, 'execution', 'empty')).isDirectory(), true);
  for (const relative of ['.DS_Store', '._finder', '__MACOSX']) assert.equal(exists(path.join(candidate, relative)), false);
  assert.deepEqual(treeSnapshot(source), sourceBefore);
  validateCloseTransition(source, candidate);
});

test('hardlink peers hidden in ignored metadata are rejected without residue', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  const linked = path.join(execution, 'linked.bin');
  fs.writeFileSync(linked, 'metadata peer\n');
  const metadata = path.join(source, '.DS_Store');
  if (!createHardlinkOrSkip(t, linked, metadata)) return;
  const receipt = attestation(root, source);
  const before = treeSnapshot(source);
  assert.throws(() => build(root, source, 'candidate', receipt), /crosses the CLOSE preservation boundary/u);
  assert.deepEqual(treeSnapshot(source), before);
  assert.equal(fs.lstatSync(linked).ino, fs.lstatSync(metadata).ino);
  assert.equal(exists(path.join(root, 'candidate')), false);
  assert.deepEqual(stageResidues(root, 'candidate'), []);
});

test('hardlinked symlinks are preserved without dereferencing when the filesystem supports them', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  fs.writeFileSync(path.join(execution, 'target.bin'), 'target\n');
  const first = path.join(execution, 'alias-a');
  const second = path.join(execution, 'alias-b');
  if (!createSymlinkOrSkip(t, 'target.bin', first, process.platform === 'win32' ? 'file' : undefined)) return;
  if (!createHardlinkOrSkip(t, first, second)) return;
  const firstMetadata = fs.lstatSync(first);
  const secondMetadata = fs.lstatSync(second);
  if (!firstMetadata.isSymbolicLink() || !secondMetadata.isSymbolicLink() || firstMetadata.ino !== secondMetadata.ino) {
    t.skip('hardlinking a symlink inode is unavailable on this filesystem');
    return;
  }
  const candidate = build(root, source);
  const copiedFirst = path.join(candidate, 'execution', 'alias-a');
  const copiedSecond = path.join(candidate, 'execution', 'alias-b');
  assert.equal(fs.lstatSync(copiedFirst).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(copiedSecond).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(copiedFirst), 'target.bin');
  assert.equal(fs.readlinkSync(copiedSecond), 'target.bin');
  assert.equal(fs.lstatSync(copiedFirst).ino, fs.lstatSync(copiedSecond).ino);
  assert.equal(fs.lstatSync(copiedFirst).nlink, 2);
  assert.notEqual(fs.lstatSync(copiedFirst).ino, firstMetadata.ino);
  validateCloseTransition(source, candidate);
});

test('an external hardlink copy failure removes only the owned stage', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  const first = path.join(execution, 'payload-a.bin');
  const second = path.join(execution, 'payload-b.bin');
  fs.writeFileSync(first, 'hardlink failure fixture\n');
  if (!createHardlinkOrSkip(t, first, second)) return;
  const receipt = attestation(root, source);
  const sourceBefore = treeSnapshot(source);
  const originalLink = fs.linkSync;
  fs.linkSync = function injectedLinkFailure(from, to, ...rest) {
    if (path.basename(String(to)) === 'payload-b.bin' && String(to).includes('.close-stage-')) {
      const error = new Error('injected link failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLink.call(fs, from, to, ...rest);
  };
  try {
    assert.throws(() => build(root, source, 'candidate', receipt), /injected link failure/u);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.deepEqual(treeSnapshot(source), sourceBefore);
  assert.equal(exists(path.join(root, 'candidate')), false);
  assert.deepEqual(stageResidues(root, 'candidate'), []);
});

test('unsupported external Unix-domain socket fails cleanly without candidate or stage', async (t) => {
  if (process.platform === 'win32') {
    t.skip('filesystem Unix-domain sockets are unavailable on Windows');
    return;
  }
  const root = temporary(t, 'stnl render sock ');
  const source = fresh(root);
  const execution = path.join(source, 'execution');
  fs.mkdirSync(execution);
  const socket = path.join(execution, 'external.sock');
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
  const receipt = attestation(root, source);
  const sourceBefore = treeSnapshot(source);
  assert.throws(() => build(root, source, 'candidate', receipt), /unsupported external filesystem entry/u);
  assert.deepEqual(treeSnapshot(source), sourceBefore);
  assert.equal(exists(path.join(root, 'candidate')), false);
  assert.deepEqual(stageResidues(root, 'candidate'), []);
});

test('internal and traversal candidate paths are rejected before rendering', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const sourceBefore = workspaceSnapshot(source);
  const internal = path.join(source, 'candidate');
  assert.throws(
    () => buildClosedCandidate(source, internal, { readinessAttestation: receipt }),
    /disjoint directories/u,
  );
  assert.equal(exists(internal), false);
  const traversal = `${root}${path.sep}unused${path.sep}..${path.sep}candidate`;
  assert.throws(
    () => buildClosedCandidate(source, traversal, { readinessAttestation: receipt }),
    /path traversal/u,
  );
  assert.equal(exists(path.join(root, 'candidate')), false);
  assert.deepEqual(workspaceSnapshot(source), sourceBefore);
});

test('candidate symlink path is rejected without touching its target', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const target = path.join(root, 'missing-target');
  const candidate = path.join(root, 'linked-candidate');
  if (!createSymlinkOrSkip(t, target, candidate, process.platform === 'win32' ? 'junction' : undefined)) return;
  assert.throws(
    () => buildClosedCandidate(source, candidate, { readinessAttestation: receipt }),
    /symlink components/u,
  );
  assert.equal(exists(target), false);
  assert.deepEqual(stageResidues(root, 'linked-candidate'), []);
});

test('nested source symlink alias is rejected without source mutation', (t) => {
  const root = temporary(t);
  const externalRoot = path.join(root, 'external-source-root');
  const realSource = fresh(path.join(externalRoot, 'one'), 'source');
  const receipt = attestation(root, realSource);
  const sourceBefore = workspaceSnapshot(realSource);
  const alias = path.join(root, 'source-alias');
  if (!createSymlinkOrSkip(t, externalRoot, alias, process.platform === 'win32' ? 'junction' : undefined)) return;
  const aliasedSource = path.join(alias, 'one', 'source');
  assert.throws(
    () => buildClosedCandidate(aliasedSource, path.join(root, 'source-alias-candidate'), { readinessAttestation: receipt }),
    /symlink components/u,
  );
  assert.equal(exists(path.join(root, 'source-alias-candidate')), false);
  assert.deepEqual(stageResidues(root, 'source-alias-candidate'), []);
  assert.deepEqual(workspaceSnapshot(realSource), sourceBefore);
});

test('nested candidate symlink alias is rejected without external mutation', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const externalRoot = path.join(root, 'external-candidate-root');
  const realParent = path.join(externalRoot, 'one', 'two');
  fs.mkdirSync(realParent, { recursive: true });
  const sentinel = path.join(externalRoot, 'sentinel.bin');
  fs.writeFileSync(sentinel, Buffer.from('candidate alias target must remain unchanged\0'));
  const before = fs.readFileSync(sentinel);
  const alias = path.join(root, 'candidate-alias');
  if (!createSymlinkOrSkip(t, externalRoot, alias, process.platform === 'win32' ? 'junction' : undefined)) return;
  const candidate = path.join(alias, 'one', 'two', 'candidate');
  assert.throws(
    () => buildClosedCandidate(source, candidate, { readinessAttestation: receipt }),
    /symlink components/u,
  );
  assert.equal(exists(path.join(realParent, 'candidate')), false);
  assert.deepEqual(stageResidues(realParent, 'candidate'), []);
  assert.deepEqual(fs.readFileSync(sentinel), before);
});

test('invalid rendered stage is removed while source remains byte-identical', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const receipt = attestation(root, source);
  const sourceBefore = treeSnapshot(source);
  const originalWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function corruptRenderedFeature(file, data, ...rest) {
    let next = data;
    if (
      path.basename(String(file)) === 'feature_spec.md'
      && path.basename(path.dirname(String(file))).startsWith('.candidate.close-stage-')
    ) {
      const rendered = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      next = Buffer.from(rendered.replace(
        'Provide deterministic invitation expiration behavior.',
        'Injected prepublication content that violates exact CLOSE authority.',
      ), 'utf8');
      injected = true;
    }
    return originalWrite.call(fs, file, next, ...rest);
  };
  try {
    assert.throws(
      () => build(root, source, 'candidate', receipt),
      (error) => error instanceof ValidationError,
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(injected, true);
  assert.deepEqual(treeSnapshot(source), sourceBefore);
  assert.equal(exists(path.join(root, 'candidate')), false);
  assert.deepEqual(stageResidues(root, 'candidate'), []);
});

for (const timing of ['before', 'after']) {
  test(`source mutation ${timing} final promotion rolls back the owned candidate`, (t) => {
    const root = temporary(t);
    const source = fresh(root);
    const receipt = attestation(root, source);
    const receiptBefore = fs.readFileSync(receipt);
    const candidate = path.join(root, 'candidate');
    const canonicalCandidate = path.join(fs.realpathSync(root), path.basename(candidate));
    const originalRename = fs.renameSync;
    let mutated = false;
    fs.renameSync = function renameWithSourceRace(from, to, ...rest) {
      const promotesCandidate = path.normalize(String(to)) === canonicalCandidate;
      if (promotesCandidate && timing === 'before' && !mutated) {
        mutateObjective(source, 'Changed after CLOSE transition validation and before promotion.');
        mutated = true;
      }
      const result = originalRename.call(fs, from, to, ...rest);
      if (promotesCandidate && timing === 'after' && !mutated) {
        mutateObjective(source, 'Changed inside the final candidate promotion.');
        mutated = true;
      }
      return result;
    };
    try {
      assert.throws(
        () => buildClosedCandidate(source, candidate, { readinessAttestation: receipt }),
        /became stale/u,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(mutated, true);
    assert.equal(exists(candidate), false);
    assert.deepEqual(stageResidues(root, 'candidate'), []);
    assert.deepEqual(fs.readFileSync(receipt), receiptBefore);
    assert.doesNotThrow(() => validateWorkspace(source));
  });
}

test('post-render CLOSE transition rejects invented, discarded, and rewritten authority', async (t) => {
  const mutations = [
    ['invented item', (feature) => {
      const extra = `### R-999 — Invented requirement

- status: in_scope
- coverage_justification: This documentary-only requirement has no observable acceptance behavior.

This record was not present in the active source.

`;
      replace(feature, '## Business Rules\n', `${extra}## Business Rules\n`);
    }, /invented canonical items/u],
    ['discarded final question', (feature) => {
      const data = fs.readFileSync(feature);
      const marker = data.indexOf(Buffer.from('## Durable Resolved Questions\n'));
      assert.notEqual(marker, -1);
      fs.writeFileSync(feature, data.subarray(0, marker));
    }, /discarded canonical items/u],
    ['rewritten requirement', (feature) => replace(
      feature,
      'An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.',
      'A rewritten requirement changes durable authority.',
    ), /changed canonical content for R-001/u],
  ];
  for (const [index, [name, mutate, diagnostic]] of mutations.entries()) {
    await t.test(name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `stnl transition ${index} `));
      try {
        const source = fresh(root);
        const candidate = build(root, source);
        mutate(path.join(candidate, 'feature_spec.md'));
        assert.throws(() => validateCloseTransition(source, candidate), diagnostic);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('valid retired tombstone bytes survive deterministic closure unchanged', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  replace(path.join(source, 'feature_spec.md'), '- R-001\n', '- R-001\n- R-002\n');
  const tombstone = Buffer.from(`### R-002 — Retired duplicate requirement

- status: retired
- retired_reason: The requirement duplicated R-001 and remains reserved for history.

This authority remains as a documentary tombstone.
`, 'utf8');
  fs.appendFileSync(path.join(source, 'shared', 'requirements.md'), Buffer.concat([Buffer.from('\n'), tombstone]));
  validateWorkspace(source);
  const candidate = build(root, source);
  assert.equal(fs.readFileSync(path.join(candidate, 'feature_spec.md')).includes(tombstone), true);
});
